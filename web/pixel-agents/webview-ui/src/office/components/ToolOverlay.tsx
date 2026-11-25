import { Fragment, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { PixelIcon } from '../../components/ui/PixelIcon.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_GAUGE_GAP_PX,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  REPEAT_CLOTHES_HUES,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_GAP_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
// quiet-office: translated labels (en/ms), attention timer, declutter, compact context gauge.
import { isAwaitingInput, markWaiting, waitingSince } from '../../hooks/waitingSince.js';
import { getLang, middleEllipsis, statusText, t, waitClock, waitClockBucket } from '../../i18n/index.js';
// quiet-office: follow the capped game loop instead of every rAF; DPR 1.
import { canvasDpr, getWallpaperOptions, isWallpaper, onFrameRendered } from '../../wallpaper.js';
import { ContextBar } from '../ContextBar.js';
import { contextLeft } from '../contextGauge.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { Character, ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';
import {
  type Box,
  GAUGE_GAP_PX,
  GAUGE_H_PX,
  gaugeColor,
  type LabelInput,
  type LabelKind,
  NAME_FONT_PX,
  STATUS_FONT_PX,
  SUB_FONT_PX,
  TINY_FONT_PX,
  visibleLabels,
} from './wallpaperLabels.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (isWallpaper) {
      // quiet-office: re-render labels only when a character moves, changes state or its
      // bubble fades. Re-rendering every frame forced a style recalc 10-20x/s for static labels.
      let last = '';
      return onFrameRendered(() => {
        // Waiting agents add their clock bucket (1 s, or 1 min past 5 min) and context %.
        const now = Date.now();
        let sig = `${getLang()};${getWallpaperOptions().privacy ? 'P;' : ''}`;
        for (const [id, ch] of officeState.characters) {
          const fade = ch.bubbleType === 'waiting' ? Math.round(ch.bubbleTimer * 10) : 0;
          const kind =
            ch.bubbleType === 'permission' ? 'permission' : isAwaitingInput(id) ? 'input' : null;
          const since = kind ? waitingSince(id, kind) : undefined;
          const clock = since !== undefined ? waitClockBucket(now - since) : '';
          const ctx = ch.contextReported
            ? Math.round((ch.contextTokens / ch.maxContextTokens) * 100)
            : '';
          sig += `${id}:${Math.round(ch.x)},${Math.round(ch.y)},${ch.state},${ch.bubbleType ?? ''},${fade},${ch.isActive ? 1 : 0},${kind ?? ''}${clock},${ctx};`;
        }
        if (sig !== last) {
          last = sig;
          setTick((n) => n + 1);
        }
      });
    }
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = canvasDpr(); // quiet-office
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  // Hovering a sub-agent swaps its lead's label for its own (they'd overlap).
  const hoveredSubParentId =
    hoveredId !== null
      ? subagentCharacters.find((s) => s.id === hoveredId)?.parentAgentId
      : undefined;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  if (isWallpaper) {
    return renderWallpaperLabels(
      officeState,
      allIds,
      agentTools,
      subagentTools,
      subagentCharacters,
      project,
      zoom,
      dpr,
    );
  }

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;

        // Speech bubble (permission dots / done checkmark) — rendered here in
        // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
        // character regardless of label visibility. Mirrors the geometry the
        // canvas renderer used. The idle "Waiting for input" state speaks
        // through its label, not a bubble.
        let bubbleNode = null;
        // Screen y of the bubble's top edge, when one shows: the label stacks above it.
        let bubbleTop: number | null = null;
        if (ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) {
          const cachedBubble = getCachedSprite(
            ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
            zoom,
          );
          const bubbleSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
          const alpha =
            ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
              ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
              : 1;
          bubbleTop =
            project.toScreenY(ch.y + bubbleSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
            (cachedBubble.height + zoom) / dpr;
          bubbleNode = (
            <div
              className="absolute -translate-x-1/2 pointer-events-none"
              style={{
                left: project.toScreenX(ch.x),
                // Bubble bottom sits one sprite pixel above the character's
                // anchor: project the anchor, then lift by the bubble's own
                // device-pixel height plus one zoomed pixel, in CSS px.
                top: bubbleTop,
                opacity: alpha,
                zIndex: OVERLAY_BUBBLE_Z_INDEX,
              }}
            >
              <OverlayBubble cached={cachedBubble} dpr={dpr} />
            </div>
          );
        }

        // Only show the label for hovered or selected agents (unless
        // always-show is on) — the bubble renders regardless.
        if (!alwaysShowOverlay && !isSelected && !isHovered) {
          return bubbleNode && <Fragment key={id}>{bubbleNode}</Fragment>;
        }

        // Position above character: the sprite's top edge (the tallest hair
        // reaches it), or the bubble's when one shows over the head.
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);
        const labelBottom = Math.min(screenY, bubbleTop ?? screenY) - TOOL_OVERLAY_GAP_PX;

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        // Likewise for a label that gives way: a sub-agent's shows only while
        // hovered or selected, even with always-show on (the lead's label
        // already names the subtask), and a hovered sub-agent's lead hides
        // its own so the sub's isn't covered.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
        const givesWay = (isSub && !isSelected && !isHovered) || id === hoveredSubParentId;
        if ((isDone && !isSelected && !isHovered) || givesWay) {
          return (
            <Fragment key={id}>
              {bubbleNode}
              <div
                className="absolute"
                style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
                data-testid="agent-overlay"
                data-agent-id={id}
              />
            </Fragment>
          );
        }

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as the server reports its context (a cleared
        // session's 0 included: a full gauge). Sub-agents never do: they have
        // no session of their own, so nothing is ever reported for them.
        // Drawn as a health bar: full when the context is empty, draining as
        // it fills (the colour still warns by the share used).
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextReported === true;

        return (
          <Fragment key={id}>
            {bubbleNode}
            <div
              // The label grows upward from labelBottom, so extra lines and the
              // context gauge never reach down over the head.
              className="absolute flex flex-col items-center -translate-x-1/2 -translate-y-full"
              style={{
                left: screenX,
                top: labelBottom,
                pointerEvents: isSelected ? 'auto' : 'none',
                opacity: alwaysShowOverlay && !isSelected && !isHovered ? 0.75 : 1,
                zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
                {dotColor && (
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                    style={{ background: dotColor }}
                  />
                )}
                <div className="flex flex-col gap-0 overflow-hidden">
                  {teamRoleLabel && (
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        fontSize: '18px',
                        color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                        fontWeight: ch.isTeamLead ? 'bold' : undefined,
                      }}
                    >
                      {teamRoleLabel}
                    </span>
                  )}
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                    }}
                  >
                    {activityText}
                  </span>
                  {ch.directoryName && (
                    <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                      {ch.directoryName}
                    </span>
                  )}
                </div>
                {isSelected && !isSub && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseAgent(id);
                    }}
                    title="Close agent"
                    className="ml-2 shrink-0"
                  >
                    {/* The panel's padding favours the text (pb > pt) and the × fills
                        rows 1–5 of its grid: 3px lower centres it on the label line. */}
                    <PixelIcon name="close" className="translate-y-3" />
                  </Button>
                )}
              </div>
              {showContextGauge && (
                <ContextBar
                  used={contextRatio}
                  width={CONTEXT_GAUGE_WIDTH_PX}
                  height={CONTEXT_GAUGE_HEIGHT_PX}
                  style={{ marginTop: CONTEXT_GAUGE_GAP_PX }}
                  title={`${Math.round(contextLeft(contextRatio) * 100)}% context left (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens used)`}
                  testId="context-gauge"
                  pct={Math.round(contextRatio * 100)}
                />
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}

// ── quiet-office: wallpaper labels ─────────────────────────────────────────

type Projection = ReturnType<typeof overlayProjection>;
type ToolRow = ToolActivity & { error?: boolean };

const WAIT_STYLE: Record<'permission' | 'input', React.CSSProperties> = {
  permission: {
    borderLeft: '6px solid var(--pixel-wp-permission)',
    background: 'var(--pixel-wp-permission-bg)',
  },
  input: { borderLeft: '6px solid var(--pixel-wp-input)', background: 'var(--pixel-wp-input-bg)' },
};

function bubbleFor(ch: Character, project: Projection, zoom: number, dpr: number) {
  if (!ch.bubbleType || (ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) return null;
  const cached = getCachedSprite(
    ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
    zoom,
  );
  const sittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
  const alpha =
    ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
      ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
      : 1;
  const top =
    project.toScreenY(ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) - (cached.height + zoom) / dpr;
  const node = (
    <div
      className="absolute -translate-x-1/2 pointer-events-none"
      style={{ left: project.toScreenX(ch.x), top, opacity: alpha, zIndex: OVERLAY_BUBBLE_Z_INDEX }}
    >
      <OverlayBubble cached={cached} dpr={dpr} />
    </div>
  );
  return { node, top };
}

/** A lead's colour for its sub-agents' tags: the hue its clothes wear (repeat hues). */
function leadHue(lead: Character | undefined): number | undefined {
  if (!lead) return undefined;
  const n = REPEAT_CLOTHES_HUES.length;
  const idx = lead.repeat > 0 ? lead.repeat - 1 : lead.palette;
  return REPEAT_CLOTHES_HUES[((idx % n) + n) % n];
}

/** Display status for an active agent, with a done-with-error marker. */
function activeStatus(tools: ToolRow[] | undefined): string {
  if (!tools || tools.length === 0) return t('thinking');
  const open = [...tools].reverse().find((row) => !row.done);
  if (open) return statusText(open.status, 16);
  const last = tools[tools.length - 1];
  return `${statusText(last.status, 16)}${last.error ? ` · ${t('toolError')}` : ''}`;
}

function renderWallpaperLabels(
  officeState: OfficeState,
  allIds: number[],
  agentTools: Record<number, ToolActivity[]>,
  subagentTools: Record<number, Record<string, ToolActivity[]>>,
  subagentCharacters: SubagentCharacter[],
  project: Projection,
  zoom: number,
  dpr: number,
) {
  const now = Date.now();
  const bubbles: React.ReactNode[] = [];
  const inputs: LabelInput[] = [];
  const meta = new Map<
    number,
    { kind: LabelKind; used: number | null; hue?: number; alert?: boolean; dim?: boolean }
  >();

  for (const id of allIds) {
    const ch = officeState.characters.get(id);
    if (!ch) continue;
    const bubble = bubbleFor(ch, project, zoom, dpr);
    if (bubble) bubbles.push(<Fragment key={`b${String(id)}`}>{bubble.node}</Fragment>);
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);
    const bottom = Math.min(screenY, bubble?.top ?? screenY) - TOOL_OVERLAY_GAP_PX;

    // Sub-agent: one-line `↳ status` tag in the lead's colour, lead name only while active.
    if (ch.isSubagent) {
      const sub = subagentCharacters.find((x) => x.id === id);
      const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
      const open = rows ? [...rows].reverse().find((t) => !t.done) : undefined;
      const alert = ch.bubbleType === 'permission';
      const text = alert
        ? statusText('Needs approval')
        : open
          ? statusText(open.status, 16)
          : statusText(sub?.label ? `Subtask: ${sub.label}` : 'Running subtask');
      const active = alert || !!open || ch.isActive;
      const lead = sub ? officeState.characters.get(sub.parentAgentId) : undefined;
      inputs.push({
        id,
        kind: 'sub',
        x: project.toScreenX(ch.x),
        bottom,
        status: `↳ ${text}`,
        name: active && lead?.directoryName ? middleEllipsis(lead.directoryName, 16) : '',
        gauge: false,
        statusFont: SUB_FONT_PX,
        nameFont: TINY_FONT_PX,
      });
      meta.set(id, { kind: 'sub', used: null, hue: leadHue(lead), alert, dim: !active });
      continue;
    }

    const tools = agentTools[id] as ToolRow[] | undefined;
    const permission =
      ch.bubbleType === 'permission' || !!tools?.some((t) => t.permissionWait && !t.done);
    const input =
      !permission &&
      (isAwaitingInput(id) || (ch.bubbleType === 'waiting' && !!ch.waitingAwaitingInput));
    // A finished turn shows only its checkmark for its 2 s, then falls to idle.
    if (!permission && !input && ch.bubbleType === 'waiting') continue;
    const kind: LabelKind = permission
      ? 'permission'
      : input
        ? 'input'
        : ch.isActive
          ? 'active'
          : 'idle';

    let status: string | null = null;
    if (kind === 'permission' || kind === 'input') {
      if (waitingSince(id, kind) === undefined) markWaiting(id, kind, undefined, now);
      const since = waitingSince(id, kind) ?? now;
      status = `${statusText(kind === 'permission' ? 'Needs approval' : WAITING_INPUT_ACTIVITY_TEXT)} · ${waitClock(now - since)}`;
    } else if (kind === 'active') {
      status = activeStatus(tools);
    }

    const used = ch.contextReported
      ? Math.min(1, Math.max(0, ch.contextTokens / ch.maxContextTokens))
      : null;
    inputs.push({
      id,
      kind,
      x: project.toScreenX(ch.x),
      bottom,
      status,
      name: middleEllipsis(ch.directoryName ?? '', 16),
      gauge: used !== null,
    });
    meta.set(id, { kind, used });
  }

  // Door signs are drawn in the canvas, under this overlay: labels slide aside instead of covering them.
  const signs: Box[] = officeState.getSignRects().map((r) => ({
    l: project.toScreenX(r.x),
    r: project.toScreenX(r.x + r.w),
    t: project.toScreenY(r.y),
    b: project.toScreenY(r.y + r.h),
  }));
  const byId = new Map(inputs.map((l) => [l.id, l]));
  // Privacy (CONTRACT v4): no labels at all; the bubbles above stay (icons, no text).
  const labels = visibleLabels(inputs, signs, getWallpaperOptions().privacy).map((p) => {
    const lab = byId.get(p.id);
    const m = meta.get(p.id);
    if (!lab || !m || p.hidden) return null;
    const waitStyle: React.CSSProperties =
      m.kind === 'permission' || m.kind === 'input'
        ? WAIT_STYLE[m.kind]
        : m.alert
          ? WAIT_STYLE.permission
          : m.hue !== undefined
            ? ({ '--wp-lead-hue': m.hue } as React.CSSProperties)
            : {};
    return (
      <div
        key={p.id}
        className="absolute -translate-x-1/2 -translate-y-full"
        style={{
          left: lab.x + p.dx,
          top: lab.bottom + p.dy,
          pointerEvents: 'none',
          opacity: m.kind === 'idle' ? 0.65 : m.dim ? 0.8 : 1,
          zIndex: OVERLAY_LABEL_Z_INDEX,
        }}
        data-testid="agent-overlay"
        data-agent-id={p.id}
        data-label-kind={m.kind}
      >
        <div
          className={`flex flex-col pixel-panel px-8 pt-2 pb-4 whitespace-nowrap leading-none${m.hue !== undefined && !m.alert ? ' wp-sub-tag' : ''}`}
          style={waitStyle}
        >
          {p.showStatus && lab.status && (
            <span className="block" style={{ fontSize: lab.statusFont ?? STATUS_FONT_PX }}>
              {lab.status}
            </span>
          )}
          {lab.name && (
            <span className="block" style={{ fontSize: lab.nameFont ?? NAME_FONT_PX }}>
              {lab.name}
            </span>
          )}
          {m.used !== null && (
            <div
              style={{
                height: GAUGE_H_PX,
                marginTop: GAUGE_GAP_PX,
                background: 'var(--pixel-wp-gauge-bg)',
              }}
              data-testid="context-gauge"
              data-context-pct={Math.round(m.used * 100)}
            >
              <div
                style={{
                  width: `${m.used * 100}%`,
                  height: '100%',
                  background: gaugeColor(m.used),
                }}
              />
            </div>
          )}
        </div>
      </div>
    );
  });

  return (
    <>
      {bubbles}
      {labels}
    </>
  );
}
