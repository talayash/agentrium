use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct PreviewProfile {
    pub enabled: bool,
    pub url_override: Option<String>,
    pub framework_hint: Option<String>,
}

/// Per-profile default action when a worktree-isolated terminal closes.
/// `None` means "always show the close modal".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeCloseAction {
    Merge,
    Squash,
    Keep,
    Discard,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigProfile {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub working_directory: String,
    pub claude_args: Vec<String>,
    pub env_vars: HashMap<String, String>,
    pub is_default: bool,
    #[serde(default)]
    pub preview: Option<PreviewProfile>,
    #[serde(default)]
    pub worktree_close_default: Option<WorktreeCloseAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HintCategory {
    pub name: String,
    pub icon: String,
    pub hints: Vec<Hint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hint {
    pub title: String,
    pub command: String,
    pub description: String,
}

pub fn get_default_hints() -> Vec<HintCategory> {
    vec![
        HintCategory {
            name: "Top 10 Commands".to_string(),
            icon: "star".to_string(),
            hints: vec![
                Hint {
                    title: "Fix this error".to_string(),
                    command: "Fix this error: [paste error]".to_string(),
                    description: "Quickly fix any error by pasting it".to_string(),
                },
                Hint {
                    title: "Explain this code".to_string(),
                    command: "Explain what this code does: [paste code]".to_string(),
                    description: "Get a clear explanation of any code".to_string(),
                },
                Hint {
                    title: "Write tests".to_string(),
                    command: "Write unit tests for [filename]".to_string(),
                    description: "Generate comprehensive tests".to_string(),
                },
                Hint {
                    title: "Refactor this".to_string(),
                    command: "Refactor this code to be cleaner: [paste code]".to_string(),
                    description: "Improve code quality and readability".to_string(),
                },
                Hint {
                    title: "Add comments".to_string(),
                    command: "Add documentation comments to [filename]".to_string(),
                    description: "Document your code automatically".to_string(),
                },
                Hint {
                    title: "Create component".to_string(),
                    command: "Create a React component for [description]".to_string(),
                    description: "Generate React/Vue/Angular components".to_string(),
                },
                Hint {
                    title: "API endpoint".to_string(),
                    command: "Create an API endpoint that [description]".to_string(),
                    description: "Build REST/GraphQL endpoints".to_string(),
                },
                Hint {
                    title: "Debug this".to_string(),
                    command: "Help me debug why [describe issue]".to_string(),
                    description: "Get help debugging tricky issues".to_string(),
                },
                Hint {
                    title: "Optimize performance".to_string(),
                    command: "Optimize the performance of [filename]".to_string(),
                    description: "Make your code faster".to_string(),
                },
                Hint {
                    title: "Convert format".to_string(),
                    command: "Convert this [from format] to [to format]".to_string(),
                    description: "Convert between file formats, languages".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Getting Started".to_string(),
            icon: "rocket".to_string(),
            hints: vec![
                Hint {
                    title: "Start Claude Code".to_string(),
                    command: "claude".to_string(),
                    description: "Launch Claude Code in interactive mode".to_string(),
                },
                Hint {
                    title: "With Custom Model".to_string(),
                    command: "claude --model opus".to_string(),
                    description: "Start with a specific model (opus, sonnet, haiku)".to_string(),
                },
                Hint {
                    title: "Skip Permissions".to_string(),
                    command: "claude --dangerously-skip-permissions".to_string(),
                    description: "Skip permission prompts (use with caution)".to_string(),
                },
                Hint {
                    title: "Resume Session".to_string(),
                    command: "claude --resume".to_string(),
                    description: "Continue from your last session".to_string(),
                },
            ],
        },
        HintCategory {
            name: "File Operations".to_string(),
            icon: "folder".to_string(),
            hints: vec![
                Hint {
                    title: "Read File".to_string(),
                    command: "Read the contents of [filename]".to_string(),
                    description: "Ask Claude to read and analyze a file".to_string(),
                },
                Hint {
                    title: "Create File".to_string(),
                    command: "Create a new file called [name] with [content]".to_string(),
                    description: "Ask Claude to create a new file".to_string(),
                },
                Hint {
                    title: "Edit File".to_string(),
                    command: "Edit [filename] and [describe changes]".to_string(),
                    description: "Ask Claude to modify an existing file".to_string(),
                },
                Hint {
                    title: "Find in Files".to_string(),
                    command: "Find all files that contain [pattern]".to_string(),
                    description: "Search across your codebase".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Git Operations".to_string(),
            icon: "git-branch".to_string(),
            hints: vec![
                Hint {
                    title: "Git Status".to_string(),
                    command: "Show me the git status".to_string(),
                    description: "Check repository status".to_string(),
                },
                Hint {
                    title: "Create Commit".to_string(),
                    command: "Commit these changes with an appropriate message".to_string(),
                    description: "Stage and commit changes".to_string(),
                },
                Hint {
                    title: "Create Branch".to_string(),
                    command: "Create a new branch called [name]".to_string(),
                    description: "Create and switch to a new branch".to_string(),
                },
                Hint {
                    title: "Create PR".to_string(),
                    command: "Create a pull request for these changes".to_string(),
                    description: "Open a pull request on GitHub".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Code Generation".to_string(),
            icon: "code".to_string(),
            hints: vec![
                Hint {
                    title: "Generate Function".to_string(),
                    command: "Write a function that [description]".to_string(),
                    description: "Generate code based on description".to_string(),
                },
                Hint {
                    title: "Refactor Code".to_string(),
                    command: "Refactor [filename] to [improvement]".to_string(),
                    description: "Improve existing code".to_string(),
                },
                Hint {
                    title: "Add Tests".to_string(),
                    command: "Write tests for [filename/function]".to_string(),
                    description: "Generate unit tests".to_string(),
                },
                Hint {
                    title: "Add Types".to_string(),
                    command: "Add TypeScript types to [filename]".to_string(),
                    description: "Add type annotations to JavaScript".to_string(),
                },
            ],
        },
        HintCategory {
            name: "Debugging".to_string(),
            icon: "bug".to_string(),
            hints: vec![
                Hint {
                    title: "Find Bug".to_string(),
                    command: "Find the bug in [filename]".to_string(),
                    description: "Ask Claude to identify issues".to_string(),
                },
                Hint {
                    title: "Explain Error".to_string(),
                    command: "Explain this error: [error message]".to_string(),
                    description: "Get explanation for error messages".to_string(),
                },
                Hint {
                    title: "Fix Issue".to_string(),
                    command: "Fix the [issue description] in [filename]".to_string(),
                    description: "Ask Claude to fix a specific problem".to_string(),
                },
                Hint {
                    title: "Security Audit".to_string(),
                    command: "Check [filename] for security vulnerabilities".to_string(),
                    description: "Find potential security issues".to_string(),
                },
            ],
        },
        HintCategory {
            name: "CLI Flags".to_string(),
            icon: "terminal".to_string(),
            hints: vec![
                Hint {
                    title: "Max Turns".to_string(),
                    command: "--max-turns <number>".to_string(),
                    description: "Limit conversation turns".to_string(),
                },
                Hint {
                    title: "Output Format".to_string(),
                    command: "--output-format json".to_string(),
                    description: "Set output format (text, json, stream-json)".to_string(),
                },
                Hint {
                    title: "Verbose Mode".to_string(),
                    command: "--verbose".to_string(),
                    description: "Enable verbose logging".to_string(),
                },
                Hint {
                    title: "Working Directory".to_string(),
                    command: "--cwd /path/to/dir".to_string(),
                    description: "Set working directory".to_string(),
                },
                Hint {
                    title: "Allowed Tools".to_string(),
                    command: "--allowed-tools Read,Write,Bash".to_string(),
                    description: "Restrict available tools".to_string(),
                },
                Hint {
                    title: "Print Cost".to_string(),
                    command: "--print-cost".to_string(),
                    description: "Show token usage and cost".to_string(),
                },
            ],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_profile() -> ConfigProfile {
        let mut env = HashMap::new();
        env.insert("KEY".to_string(), "value".to_string());
        ConfigProfile {
            id: "p1".to_string(),
            name: "Default".to_string(),
            description: Some("desc".to_string()),
            working_directory: "C:/work".to_string(),
            claude_args: vec!["--model".to_string(), "opus".to_string()],
            env_vars: env,
            is_default: true,
            preview: None,
            worktree_close_default: None,
        }
    }

    #[test]
    fn config_profile_serde_round_trips() {
        let p = sample_profile();
        let json = serde_json::to_string(&p).unwrap();
        let back: ConfigProfile = serde_json::from_str(&json).unwrap();

        assert_eq!(back.id, p.id);
        assert_eq!(back.name, p.name);
        assert_eq!(back.description, p.description);
        assert_eq!(back.working_directory, p.working_directory);
        assert_eq!(back.claude_args, p.claude_args);
        assert_eq!(back.env_vars, p.env_vars);
        assert_eq!(back.is_default, p.is_default);
    }

    #[test]
    fn config_profile_round_trips_when_optional_fields_are_empty() {
        let p = ConfigProfile {
            id: "p1".to_string(),
            name: "min".to_string(),
            description: None,
            working_directory: String::new(),
            claude_args: vec![],
            env_vars: HashMap::new(),
            is_default: false,
            preview: None,
            worktree_close_default: None,
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: ConfigProfile = serde_json::from_str(&json).unwrap();

        assert_eq!(back.description, None);
        assert!(back.claude_args.is_empty());
        assert!(back.env_vars.is_empty());
    }

    #[test]
    fn preview_profile_default_and_roundtrip() {
        let p = PreviewProfile {
            enabled: true,
            url_override: Some("http://localhost:3000".into()),
            framework_hint: Some("vite".into()),
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: PreviewProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.enabled, true);
        assert_eq!(back.url_override.as_deref(), Some("http://localhost:3000"));
        assert_eq!(back.framework_hint.as_deref(), Some("vite"));
    }

    #[test]
    fn missing_preview_deserializes_as_none_on_config_profile() {
        // Simulate an old serialized ConfigProfile without the preview field.
        // Include every non-defaultable field (id, name, working_directory,
        // claude_args, env_vars, is_default) so serde is not asked to
        // synthesise them - the assertion under test is that `preview`
        // defaults to None when absent.
        let json = r#"{
            "id": "p1",
            "name": "x",
            "description": null,
            "working_directory": "/tmp",
            "claude_args": [],
            "env_vars": {},
            "is_default": false
        }"#;
        let cfg: ConfigProfile = serde_json::from_str(json).unwrap();
        assert!(cfg.preview.is_none());
    }

    #[test]
    fn default_hints_have_at_least_one_category_and_no_blank_entries() {
        let categories = get_default_hints();
        assert!(!categories.is_empty(), "expected at least one category");

        for cat in &categories {
            assert!(!cat.name.is_empty(), "category name is blank");
            assert!(!cat.icon.is_empty(), "category icon is blank");
            assert!(!cat.hints.is_empty(), "category {} has no hints", cat.name);
            for hint in &cat.hints {
                assert!(!hint.title.is_empty(), "hint title in {} is blank", cat.name);
                assert!(!hint.command.is_empty(), "hint command in {} is blank", cat.name);
                assert!(
                    !hint.description.is_empty(),
                    "hint description in {} is blank",
                    cat.name
                );
            }
        }
    }

    #[test]
    fn default_hints_lead_with_top_10_commands_category() {
        // The UI surfaces categories in order; "Top 10 Commands" must come
        // first so the most common prompts are visible above the fold.
        let categories = get_default_hints();
        assert_eq!(categories[0].name, "Top 10 Commands");
        assert_eq!(categories[0].hints.len(), 10);
    }
}
