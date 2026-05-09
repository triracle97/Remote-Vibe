import { Navigate, useParams } from 'react-router-dom';
import { useTerminalsStore } from '../store/terminals';
import { TerminalView } from '../features/terminal/TerminalView';

export function Terminal(): JSX.Element {
  const { id } = useParams();
  const term = useTerminalsStore((s) => (id ? s.terminals[id] : undefined));
  if (!id || !term) return <Navigate to="/sessions" replace />;
  return <TerminalView termId={id} />;
}
