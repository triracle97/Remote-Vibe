import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './shell/AppShell';
import { BoardPage } from './pages/Board';
import { Home } from './pages/Home';
import { Session } from './pages/Session';
import { Conductor } from './pages/Conductor';
import { Sessions } from './pages/Sessions';
import { Projects } from './pages/Projects';
import { Settings } from './pages/Settings';
import { Terminal } from './pages/Terminal';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/session/:id" element={<Session />} />
        {/* Nested under the session so the pipeline scan stays scoped to that
            session's dirs, and so Back has somewhere obvious to go. */}
        <Route path="/session/:id/conductor" element={<Conductor />} />
        <Route path="/terminal/:id" element={<Terminal />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
