import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Facets, Trigger, WorkflowCatalog, WorkflowStep } from '../lib/types';
import { BLOCKS, BLOCK_GROUPS, blockMeta, summarizeStep, summarizeTrigger, validateStep } from '../lib/workflow-blocks';
import { Badge, JsonEditor } from './ui';
import { useI18n } from '../lib/i18n';
import { StepForm, TriggerEditor } from './StepForms';

export interface FlowDefinition {
  trigger: Trigger;
  steps: WorkflowStep[];
}

interface Props {
  value: FlowDefinition;
  onChange: (next: FlowDefinition) => void;
  catalog: WorkflowCatalog;
  facets: Facets | null;
  /** Server-side validation errors keyed by step index (from a failed save). */
  serverErrors?: Record<number, string>;
}

const TRIGGER_ID = 'trigger';
const END_ID = 'end';
let uidCounter = 0;
const newUid = () => `s${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

/**
 * No-code editor: palette of blocks on the left, the workflow as a vertical
 * chain of nodes in the middle (drag to reorder, drag from the palette to
 * insert) and an inspector with the selected block's parameters on the right.
 * The result is exactly the same JSON the form / JSON editors produce.
 */
export default function FlowCanvas({ value, onChange, catalog, facets, serverErrors }: Props) {
  const { t, tOr, tk } = useI18n();
  const stepLabel = (type: string) => tOr(`step.${type}`, catalog.steps.find((s) => s.type === type)?.label ?? type);
  const stepDescription = (type: string) => tOr(`step.${type}.d`, catalog.steps.find((s) => s.type === type)?.description ?? '');
  // Stable ids for the steps so dnd-kit can track them across re-orders.
  const idsRef = useRef<string[]>([]);
  if (idsRef.current.length !== value.steps.length) {
    idsRef.current = value.steps.map((_, i) => idsRef.current[i] ?? newUid());
  }
  const ids = idsRef.current;

  const [selected, setSelected] = useState<string | null>(TRIGGER_ID);
  const [dragging, setDragging] = useState<{ kind: 'palette' | 'step'; type: string; id: string } | null>(null);
  /** index where a palette block would be inserted while dragging over the chain */
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [inspectorJson, setInspectorJson] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const problems = useMemo(() => value.steps.map((s, i) => { const key = validateStep(s, i, value.steps, value.trigger); return key ? tk(key) : null; }), [value, tk]);

  useEffect(() => {
    if (selected && selected !== TRIGGER_ID && !ids.includes(selected)) setSelected(TRIGGER_ID);
  }, [ids, selected]);

  const setSteps = (steps: WorkflowStep[], newIds: string[]) => {
    idsRef.current = newIds;
    onChange({ ...value, steps });
  };

  const insertStep = (type: string, index: number) => {
    const def = catalog.steps.find((s) => s.type === type);
    const step = { ...((def?.example as WorkflowStep) ?? { type }) };
    const id = newUid();
    const steps = [...value.steps];
    const newIds = [...ids];
    steps.splice(index, 0, step);
    newIds.splice(index, 0, id);
    setSteps(steps, newIds);
    setSelected(id);
    setInspectorJson(false);
  };

  const removeStep = (id: string) => {
    const i = ids.indexOf(id);
    if (i < 0) return;
    setSteps(
      value.steps.filter((_, j) => j !== i),
      ids.filter((_, j) => j !== i),
    );
    if (selected === id) setSelected(TRIGGER_ID);
  };

  const duplicateStep = (id: string) => {
    const i = ids.indexOf(id);
    if (i < 0) return;
    const steps = [...value.steps];
    const newIds = [...ids];
    const copyId = newUid();
    steps.splice(i + 1, 0, JSON.parse(JSON.stringify(value.steps[i])) as WorkflowStep);
    newIds.splice(i + 1, 0, copyId);
    setSteps(steps, newIds);
    setSelected(copyId);
  };

  const updateStep = (id: string, step: WorkflowStep) => {
    const i = ids.indexOf(id);
    if (i < 0) return;
    onChange({ ...value, steps: value.steps.map((s, j) => (j === i ? step : s)) });
  };

  // ------------------------------------------------------------ drag & drop
  const indexForOver = (overId: string | number | undefined): number => {
    if (overId === undefined) return value.steps.length;
    if (overId === TRIGGER_ID) return 0;
    if (overId === END_ID) return value.steps.length;
    const i = ids.indexOf(String(overId));
    return i < 0 ? value.steps.length : i;
  };

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as { kind: 'palette' | 'step'; type: string } | undefined;
    if (!data) return;
    setDragging({ kind: data.kind, type: data.type, id: String(e.active.id) });
  };

  const onDragOver = (e: DragOverEvent) => {
    if (dragging?.kind !== 'palette') return;
    setInsertAt(e.over ? indexForOver(e.over.id) : null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const current = dragging;
    setDragging(null);
    setInsertAt(null);
    if (!current) return;
    if (current.kind === 'palette') {
      if (e.over) insertStep(current.type, indexForOver(e.over.id));
      return;
    }
    if (!e.over || e.over.id === e.active.id) return;
    const from = ids.indexOf(String(e.active.id));
    let to = indexForOver(e.over.id);
    if (e.over.id === END_ID) to = value.steps.length - 1;
    if (from < 0 || to < 0) return;
    setSteps(arrayMove(value.steps, from, to), arrayMove(ids, from, to));
  };

  const selectedIndex = selected && selected !== TRIGGER_ID ? ids.indexOf(selected) : -1;
  const selectedStep = selectedIndex >= 0 ? value.steps[selectedIndex] : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => (setDragging(null), setInsertAt(null))}>
      <div className="flow">
        {/* ---------------------------------------------------- palette */}
        <aside className="flow-palette">
          <div className="flow-palette-title">{t('wf.c.blocks')}</div>
          <p className="muted small">{t('wf.c.blocksHelp')}</p>
          {BLOCK_GROUPS.map((group) => (
            <div key={group} className="palette-group">
              <div className="palette-group-title">{tOr(`wf.c.group.${group}`, group)}</div>
              {BLOCKS.filter((b) => b.group === group).map((b) => (
                <PaletteItem key={b.type} type={b.type} label={stepLabel(b.type)} description={stepDescription(b.type)} onAdd={() => insertStep(b.type, value.steps.length)} />
              ))}
            </div>
          ))}
        </aside>

        {/* ---------------------------------------------------- canvas */}
        <div className="flow-canvas">
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <TriggerNode trigger={value.trigger} selected={selected === TRIGGER_ID} onSelect={() => (setSelected(TRIGGER_ID), setInspectorJson(false))} />
            {insertAt === 0 && dragging?.kind === 'palette' && <InsertGhost type={dragging.type} label={stepLabel(dragging.type)} />}
            {value.steps.map((step, i) => (
              <div key={ids[i]} className="flow-chain-item">
                <Connector />
                <StepNode
                  id={ids[i]!}
                  index={i}
                  step={step}
                  label={stepLabel(step.type)}
                  summary={summarizeStep(step, tk)}
                  selected={selected === ids[i]}
                  problem={serverErrors?.[i] ?? problems[i] ?? null}
                  serverError={!!serverErrors?.[i]}
                  onSelect={() => (setSelected(ids[i]!), setInspectorJson(false))}
                  onRemove={() => removeStep(ids[i]!)}
                  onDuplicate={() => duplicateStep(ids[i]!)}
                />
                {insertAt === i + 1 && dragging?.kind === 'palette' && <InsertGhost type={dragging.type} label={stepLabel(dragging.type)} />}
              </div>
            ))}
          </SortableContext>
          <Connector />
          <EndZone empty={value.steps.length === 0} highlighted={dragging?.kind === 'palette' && insertAt === value.steps.length} />
        </div>

        {/* ---------------------------------------------------- inspector */}
        <aside className="flow-inspector">
          {selected === TRIGGER_ID && (
            <>
              <div className="inspector-title">
                <span className="node-icon">▶</span> {t('wf.c.trigger')}
              </div>
              <p className="muted small">{t('wf.c.triggerHelp')}</p>
              <TriggerEditor trigger={value.trigger} events={catalog.events} onChange={(trigger) => onChange({ ...value, trigger })} />
            </>
          )}
          {selectedStep && selected && (
            <>
              <div className="inspector-title">
                <span className="node-icon">{blockMeta(selectedStep.type).icon}</span> {stepLabel(selectedStep.type)}
                <span className="muted small"> · {t('wf.c.step', { n: selectedIndex + 1 })}</span>
              </div>
              <p className="muted small">{stepDescription(selectedStep.type)}</p>
              {(serverErrors?.[selectedIndex] ?? problems[selectedIndex]) && <div className="field-error">{serverErrors?.[selectedIndex] ?? problems[selectedIndex]}</div>}
              <div className="inspector-actions">
                <button className={`btn btn-sm ${inspectorJson ? 'active' : ''}`} onClick={() => setInspectorJson(!inspectorJson)}>
                  {inspectorJson ? t('wf.mode.form') : 'JSON'}
                </button>
                <button className="btn btn-sm" onClick={() => duplicateStep(selected)}>
                  {t('wf.c.duplicate')}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => removeStep(selected)}>
                  {t('common.remove')}
                </button>
              </div>
              {inspectorJson ? (
                <JsonEditor
                  value={(() => {
                    const { type: _t, ...params } = selectedStep;
                    return params;
                  })()}
                  onChange={(v) => updateStep(selected, { type: selectedStep.type, ...(v as Record<string, unknown>) })}
                  rows={14}
                />
              ) : (
                <StepForm step={selectedStep} set={(patch) => updateStep(selected, { ...selectedStep, ...patch })} facets={facets} catalog={catalog} onJson={() => setInspectorJson(true)} />
              )}
            </>
          )}
          {!selectedStep && selected !== TRIGGER_ID && <p className="muted">{t('wf.c.selectBlock')}</p>}
        </aside>
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className={`flow-node tone-${blockMeta(dragging.type).tone} dragging`}>
            <span className="node-icon">{blockMeta(dragging.type).icon}</span>
            <span className="node-label">{stepLabel(dragging.type)}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

// ---------------------------------------------------------------- pieces
function PaletteItem({ type, label, description, onAdd }: { type: string; label: string; description: string; onAdd: () => void }) {
  const meta = blockMeta(type);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette:${type}`, data: { kind: 'palette', type } });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={`palette-item tone-${meta.tone} ${isDragging ? 'is-dragging' : ''}`} title={description} onClick={onAdd} role="button" tabIndex={0}>
      <span className="node-icon">{meta.icon}</span>
      <span className="palette-label">{label}</span>
      <span className="palette-add">+</span>
    </div>
  );
}

function TriggerNode({ trigger, selected, onSelect }: { trigger: Trigger; selected: boolean; onSelect: () => void }) {
  const { t, tk } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: TRIGGER_ID });
  return (
    <div ref={setNodeRef} className={`flow-node flow-trigger ${selected ? 'selected' : ''} ${isOver ? 'over' : ''}`} onClick={onSelect}>
      <span className="node-icon">▶</span>
      <div className="node-body">
        <div className="node-label">{t('wf.c.trigger')}</div>
        <div className="node-summary">{summarizeTrigger(trigger, tk)}</div>
      </div>
    </div>
  );
}

function StepNode({
  id,
  index,
  step,
  label,
  summary,
  selected,
  problem,
  serverError,
  onSelect,
  onRemove,
  onDuplicate,
}: {
  id: string;
  index: number;
  step: WorkflowStep;
  label: string;
  summary: string;
  selected: boolean;
  problem: string | null;
  serverError: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const meta = blockMeta(step.type);
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data: { kind: 'step', type: step.type } });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flow-node tone-${meta.tone} ${selected ? 'selected' : ''} ${isDragging ? 'is-dragging' : ''} ${problem ? (serverError ? 'has-error' : 'has-warning') : ''}`}
      onClick={onSelect}
    >
      <span className="node-handle" {...attributes} {...listeners} title={t('wf.c.dragReorder')} onClick={(e) => e.stopPropagation()}>
        ⋮⋮
      </span>
      <span className="node-index">{index + 1}</span>
      <span className="node-icon">{meta.icon}</span>
      <div className="node-body">
        <div className="node-label">
          {label}
          {problem && (
            <Badge tone={serverError ? 'error' : 'warning'} title={problem}>
              !
            </Badge>
          )}
        </div>
        <div className="node-summary">{summary}</div>
      </div>
      <span className="node-actions">
        <button className="btn btn-ghost btn-sm" title={t('wf.c.duplicate')} onClick={(e) => (e.stopPropagation(), onDuplicate())}>
          ❏
        </button>
        <button className="btn btn-ghost btn-sm" title={t('common.remove')} onClick={(e) => (e.stopPropagation(), onRemove())}>
          ✕
        </button>
      </span>
    </div>
  );
}

function InsertGhost({ type, label }: { type: string; label: string }) {
  const meta = blockMeta(type);
  const { t } = useI18n();
  return (
    <div className="flow-chain-item">
      <Connector />
      <div className={`flow-node ghost tone-${meta.tone}`}>
        <span className="node-icon">{meta.icon}</span>
        <div className="node-body">
          <div className="node-label">{label}</div>
          <div className="node-summary muted">{t('wf.c.dropHere')}</div>
        </div>
      </div>
    </div>
  );
}

function EndZone({ empty, highlighted }: { empty: boolean; highlighted: boolean }) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: END_ID });
  return (
    <div ref={setNodeRef} className={`flow-end ${isOver || highlighted ? 'over' : ''}`}>
      {empty ? t('wf.c.emptyEnd') : t('wf.c.end')}
    </div>
  );
}

function Connector() {
  return <div className="flow-connector" />;
}
