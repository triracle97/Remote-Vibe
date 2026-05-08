import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './shell/AppShell';
import { Home } from './pages/Home';
import { Session } from './pages/Session';
import { Sessions } from './pages/Sessions';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/session/:id" element={<Session />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
