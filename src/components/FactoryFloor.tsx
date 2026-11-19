import { Factory } from 'lucide-react';
import { EmptyState } from './ui/EmptyState';
import { useFactoryStore } from '../store/factoryStore';

/** Placeholder floor for a factory tab; the real floor replaces this body. */
export function FactoryFloor({ factoryId }: { factoryId: string }) {
  const name = useFactoryStore((s) => s.factories[factoryId]?.name ?? 'Factory');
  return <EmptyState icon={<Factory size={20} />} title={name} />;
}
