import { useEffect, useState, type JSX } from 'react';
import { getBridgeClient } from '../../services/bridge-client-singleton';
import { useBoardStore } from '../board/boardStore';
import { ModelEffortPicker } from './ModelEffortPicker';
import type { AgentKind, EffortLevel } from '../../types/protocol';

/**
 * Change model / effort on a session that is already running.
 *
 * For Claude this lands immediately: the CLI honours `/model` and `/effort`
 * sent as ordinary user messages on its stream-json stdin, so the bridge just
 * writes them and the switch applies to the very next turn with the transcript
 * intact. For Codex there is no live process between turns, so the value is
 * stored and the next `codex exec` picks it up.
 *
 * The card in the board store is the source of truth for what the session is
 * currently on, so this stays right even when the change came from elsewhere.
 */
export function SessionModelSwitch({
  sessionId,
  agent,
}: {
  sessionId: string;
  agent: AgentKind;
}): JSX.Element {
  const card = useBoardStore((s) => s.cards[sessionId]);
  // Mirror locally so the selects respond instantly; the broadcast reconciles.
  const [model, setModel] = useState<string | null>(card?.model ?? null);
  const [effort, setEffort] = useState<EffortLevel | null>(card?.effort ?? null);

  useEffect(() => {
    if (card === undefined) return;
    setModel(card.model);
    setEffort(card.effort);
  }, [card?.model, card?.effort, card]);

  const push = (next: { model?: string | null; effort?: EffortLevel | null }): void => {
    getBridgeClient().send({ type: 'set_session_model', sessionId, ...next });
  };

  return (
    <ModelEffortPicker
      compact
      agent={agent}
      model={model}
      effort={effort}
      onModelChange={(m) => {
        setModel(m);
        push({ model: m });
      }}
      onEffortChange={(e) => {
        setEffort(e);
        push({ effort: e });
      }}
    />
  );
}
