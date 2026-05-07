import mermaid from 'mermaid';

let initialized = false;

function init(): void {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
  });
  initialized = true;
}

export async function renderMermaid(id: string, source: string): Promise<{ svg: string }> {
  init();
  const result = await mermaid.render(id, source);
  return { svg: result.svg };
}
