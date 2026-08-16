import { canRun, detectCapabilities, type CapabilityResult } from './capabilities';
import * as T from './model/time';

const CLASS_BY_LEVEL = { ok: 'ok', degraded: 'warn', missing: 'bad' } as const;
const GLYPH_BY_LEVEL = { ok: 'OK', degraded: '~', missing: 'X' } as const;

function row(label: string, valueHtml: string, cls?: string): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const k = document.createElement('td');
  k.className = 'k';
  k.textContent = label;
  const v = document.createElement('td');
  if (cls) v.className = cls;
  v.innerHTML = valueHtml;
  tr.append(k, v);
  return tr;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function renderCapability(r: CapabilityResult): HTMLTableRowElement {
  const cls = CLASS_BY_LEVEL[r.level];
  const glyph = GLYPH_BY_LEVEL[r.level];
  const optional = r.optional && r.level !== 'ok' ? ' <span style="opacity:.6">(optional)</span>' : '';
  return row(
    r.label,
    `<span class="${cls}">${glyph}</span> ${escapeHtml(r.detail)}${optional}`,
  );
}

async function boot(): Promise<void> {
  const table = document.querySelector<HTMLTableElement>('#caps');
  if (!table) return;
  const body = document.createElement('tbody');

  const results = await detectCapabilities();
  for (const r of results) body.append(renderCapability(r));

  body.append(
    row(
      'Status',
      canRun(results)
        ? '<span class="ok">Ready.</span> Model layer is in place; editor UI lands with L1.'
        : '<span class="bad">This browser cannot run the editor.</span> Chromium 121+ is required.',
    ),
  );

  // Proof of life for the time layer — 29.97 drop-frame is the classic trap.
  const oneHourDf = T.fromFrames(107892, T.FPS_29_97);
  body.append(
    row(
      'Time layer',
      `${escapeHtml(T.toTimecode(oneHourDf, T.FPS_29_97))} = ${escapeHtml(
        T.debugTime(oneHourDf),
      )} s exactly (${escapeHtml(T.formatDuration(oneHourDf))})`,
    ),
  );

  table.replaceChildren(body);
}

void boot();
