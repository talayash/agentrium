// Pure DB helpers for the Changelists Lite feature.
// "Default" is implicit: any file without a row in changelist_files belongs
// to Default. So Default is always present, never created, never deletable.
// Mappings persist across commits ("sticky" — IntelliJ behaviour).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangelistInfo {
    pub id: Option<i64>,
    pub name: String,
    pub is_default: bool,
}

const RESERVED_DEFAULT: &str = "Default";
const MAX_NAME_LEN: usize = 80;

fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Changelist name cannot be empty".to_string());
    }
    if trimmed.len() > MAX_NAME_LEN {
        return Err(format!("Changelist name must be <= {} characters", MAX_NAME_LEN));
    }
    if trimmed.eq_ignore_ascii_case(RESERVED_DEFAULT) {
        return Err("\"Default\" is reserved for the implicit changelist".to_string());
    }
    Ok(())
}

pub fn list_changelists(conn: &Connection, repo_path: &str) -> Result<Vec<ChangelistInfo>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM changelists WHERE repo_path = ?1 ORDER BY sort_order, created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![repo_path], |r| {
            Ok(ChangelistInfo {
                id: Some(r.get::<_, i64>(0)?),
                name: r.get::<_, String>(1)?,
                is_default: false,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<ChangelistInfo> = Vec::new();
    out.push(ChangelistInfo { id: None, name: RESERVED_DEFAULT.to_string(), is_default: true });
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn create_changelist(conn: &Connection, repo_path: &str, name: &str) -> Result<i64, String> {
    validate_name(name)?;
    let trimmed = name.trim();
    conn.execute(
        "INSERT INTO changelists (repo_path, name) VALUES (?1, ?2)",
        params![repo_path, trimmed],
    )
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("UNIQUE") {
            format!("A changelist named \"{}\" already exists in this repo", trimmed)
        } else {
            msg
        }
    })?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_changelist(conn: &Connection, id: i64, new_name: &str) -> Result<(), String> {
    validate_name(new_name)?;
    let trimmed = new_name.trim();
    let changed = conn
        .execute(
            "UPDATE changelists SET name = ?1 WHERE id = ?2",
            params![trimmed, id],
        )
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("UNIQUE") {
                format!("A changelist named \"{}\" already exists", trimmed)
            } else {
                msg
            }
        })?;
    if changed == 0 {
        return Err(format!("Changelist {} not found", id));
    }
    Ok(())
}

pub fn delete_changelist(conn: &Connection, id: i64) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM changelists WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("Changelist {} not found", id));
    }
    Ok(())
}

pub fn assign_files_to_changelist(
    conn: &Connection,
    repo_path: &str,
    file_paths: &[String],
    changelist_id: Option<i64>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for fp in file_paths {
        if let Some(id) = changelist_id {
            tx.execute(
                "INSERT INTO changelist_files (repo_path, file_path, changelist_id)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(repo_path, file_path) DO UPDATE SET changelist_id = excluded.changelist_id",
                params![repo_path, fp, id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                "DELETE FROM changelist_files WHERE repo_path = ?1 AND file_path = ?2",
                params![repo_path, fp],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_changelist_assignments(
    conn: &Connection,
    repo_path: &str,
) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT file_path, changelist_id FROM changelist_files WHERE repo_path = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![repo_path], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    fn db() -> Database { Database::new_in_memory().unwrap() }

    #[test]
    fn list_starts_with_only_default() {
        let d = db();
        let lists = list_changelists(d.conn(), "/r").unwrap();
        assert_eq!(lists.len(), 1);
        assert!(lists[0].is_default);
        assert_eq!(lists[0].name, "Default");
    }

    #[test]
    fn create_and_list_named() {
        let d = db();
        let id = create_changelist(d.conn(), "/r", "feature-a").unwrap();
        assert!(id > 0);
        let lists = list_changelists(d.conn(), "/r").unwrap();
        assert_eq!(lists.len(), 2);
        assert_eq!(lists[1].name, "feature-a");
    }

    #[test]
    fn rejects_default_name() {
        let d = db();
        assert!(create_changelist(d.conn(), "/r", "Default").is_err());
        assert!(create_changelist(d.conn(), "/r", "default").is_err());
    }

    #[test]
    fn rejects_duplicate_name_in_same_repo() {
        let d = db();
        create_changelist(d.conn(), "/r", "x").unwrap();
        assert!(create_changelist(d.conn(), "/r", "x").is_err());
        assert!(create_changelist(d.conn(), "/r2", "x").is_ok());
    }

    #[test]
    fn rename_updates_name() {
        let d = db();
        let id = create_changelist(d.conn(), "/r", "old").unwrap();
        rename_changelist(d.conn(), id, "new").unwrap();
        let lists = list_changelists(d.conn(), "/r").unwrap();
        assert_eq!(lists[1].name, "new");
    }

    #[test]
    fn delete_cascades_files() {
        let d = db();
        let id = create_changelist(d.conn(), "/r", "x").unwrap();
        assign_files_to_changelist(d.conn(), "/r", &["a.txt".into()], Some(id)).unwrap();
        let count: i64 = d.conn().query_row(
            "SELECT COUNT(*) FROM changelist_files WHERE changelist_id = ?1",
            params![id], |r| r.get(0)
        ).unwrap();
        assert_eq!(count, 1);

        delete_changelist(d.conn(), id).unwrap();
        let after: i64 = d.conn().query_row(
            "SELECT COUNT(*) FROM changelist_files WHERE changelist_id = ?1",
            params![id], |r| r.get(0)
        ).unwrap();
        assert_eq!(after, 0);
    }

    #[test]
    fn assign_to_none_clears_mapping() {
        let d = db();
        let id = create_changelist(d.conn(), "/r", "x").unwrap();
        assign_files_to_changelist(d.conn(), "/r", &["a.txt".into()], Some(id)).unwrap();
        assign_files_to_changelist(d.conn(), "/r", &["a.txt".into()], None).unwrap();
        let count: i64 = d.conn().query_row(
            "SELECT COUNT(*) FROM changelist_files WHERE repo_path = '/r'",
            [], |r| r.get(0)
        ).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn get_assignments_returns_mappings() {
        let d = db();
        let id1 = create_changelist(d.conn(), "/r", "list1").unwrap();
        let id2 = create_changelist(d.conn(), "/r", "list2").unwrap();
        assign_files_to_changelist(d.conn(), "/r", &["a.txt".into(), "b.txt".into()], Some(id1)).unwrap();
        assign_files_to_changelist(d.conn(), "/r", &["c.txt".into()], Some(id2)).unwrap();

        let mut got = get_changelist_assignments(d.conn(), "/r").unwrap();
        got.sort_by_key(|(p, _)| p.clone());
        assert_eq!(got, vec![
            ("a.txt".into(), id1),
            ("b.txt".into(), id1),
            ("c.txt".into(), id2),
        ]);
    }
}
