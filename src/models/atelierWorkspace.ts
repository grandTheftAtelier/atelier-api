/**
 * Durable, server-authoritative live workspace for one cloud pack.
 *
 * Immutable revisions remain build/publish checkpoints.  This document is the
 * mutable collaboration head: every accepted operation increments `version`
 * exactly once and the WebSocket broadcasts that accepted operation.
 */

import { col } from "../mongodb";
import {
  collectReferencedSha256s,
  parseRevisionDrawables,
  type RevisionAssetRef,
  type RevisionDrawable,
} from "./atelierRevision";

export interface WorkspaceGroup {
  id: string;
  name: string;
  color: string;
}

export interface WorkspaceTattooPlacement {
  uvPosX: number;
  uvPosY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export interface WorkspaceTattoo {
  id: string;
  label: string;
  groupId: string | null;
  zone: "torso" | "head" | "left_arm" | "right_arm" | "left_leg" | "right_leg";
  type: "tattoo" | "badge";
  gender: "both" | "male" | "female";
  nameMale: string | null;
  nameFemale: string | null;
  image: RevisionAssetRef | null;
  garment: string;
  textLabel: string;
  eFacing: string | null;
  cost: number;
  placement: WorkspaceTattooPlacement | null;
}

export interface WorkspaceProject {
  /** Shared logical project id (all clones of a pack use the same id). */
  id: string;
  name: string;
  createdAt: string;
  settings: { dlcName: string; defaultGender: "male" | "female" };
  groups: WorkspaceGroup[];
  drawables: RevisionDrawable[];
  tattooCollection: { name: string; label: string };
  tattoos: WorkspaceTattoo[];
}

export type WorkspaceEntityType = "group" | "drawable" | "tattoo";

export type WorkspaceOperation =
  | {
      kind: "project.patch";
      patch: {
        name?: string;
        settings?: Partial<WorkspaceProject["settings"]>;
        tattooCollection?: Partial<WorkspaceProject["tattooCollection"]>;
      };
    }
  | {
      kind: "entity.upsert";
      entityType: WorkspaceEntityType;
      entity: WorkspaceGroup | RevisionDrawable | WorkspaceTattoo;
    }
  | {
      kind: "entity.patch";
      entityType: WorkspaceEntityType;
      id: string;
      patch: Record<string, unknown>;
    }
  | { kind: "entity.delete"; entityType: WorkspaceEntityType; id: string }
  | { kind: "order.set"; entityType: "drawable" | "tattoo"; ids: string[] }
  | { kind: "batch"; operations: WorkspaceLeafOperation[] };

export type WorkspaceLeafOperation = Exclude<WorkspaceOperation, { kind: "batch" }>;

export interface WorkspaceRecentOperation {
  operationId: string;
  version: number;
}

/** Permanent idempotency receipt. The small ring embedded in the workspace
 * covers the crash window between the atomic workspace CAS and this insert;
 * this collection prevents a delayed/offline retry from ever reapplying an
 * old operation after that ring has rolled over. */
export interface WorkspaceOperationReceipt {
  /** Deterministic for new rows so idempotency does not depend on a background
   * secondary-index build having completed yet. Legacy rows may use ObjectId. */
  _id?: string;
  packId: string;
  operationId: string;
  version: number;
  createdAt: Date;
}

export interface AtelierWorkspace {
  /** New workspaces use packId as Mongo's always-unique primary key. */
  _id?: string;
  packId: string;
  schemaVersion: 1;
  version: number;
  project: WorkspaceProject;
  recentOperations: WorkspaceRecentOperation[];
  createdAt: Date;
  updatedAt: Date;
  updatedByDiscordId: string;
  updatedByDeviceId: string;
}

export async function workspacesCol() {
  return col<AtelierWorkspace>("atelierWorkspaces");
}

export async function workspaceOperationReceiptsCol() {
  return col<WorkspaceOperationReceipt>("atelierWorkspaceOperations");
}

type ParseResult<T> = { ok: T } | { error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA_RE = /^[0-9a-f]{64}$/u;
const TATTOO_ZONES = new Set(["torso", "head", "left_arm", "right_arm", "left_leg", "right_leg"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsUnsafeObjectKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsafeObjectKey);
  if (!isObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") return true;
    if (containsUnsafeObjectKey(nested)) return true;
  }
  return false;
}

function stringValue(value: unknown, field: string, max: number, allowEmpty = true): ParseResult<string> {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim() === "")) {
    return { error: `${field} must be a string (max ${max} chars)` };
  }
  return { ok: value };
}

function nullableString(value: unknown, field: string, max: number): ParseResult<string | null> {
  if (value === null) return { ok: null };
  return stringValue(value, field, max);
}

function parseAsset(value: unknown, field: string): ParseResult<RevisionAssetRef | null> {
  if (value === null) return { ok: null };
  if (!isObject(value)) return { error: `${field} must be null or an object` };
  const sha256 = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
  if (!SHA_RE.test(sha256)) return { error: `${field}.sha256 must be 64 hex chars` };
  if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 1) {
    return { error: `${field}.size must be a positive integer` };
  }
  const exportName = stringValue(value.exportName, `${field}.exportName`, 200, false);
  if ("error" in exportName) return exportName;
  return { ok: { sha256, size: value.size, exportName: exportName.ok } };
}

function parseGroups(value: unknown): ParseResult<WorkspaceGroup[]> {
  if (!Array.isArray(value) || value.length > 2_000) return { error: "groups must be an array (max 2000)" };
  const groups: WorkspaceGroup[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isObject(item)) return { error: `groups[${i}] must be an object` };
    const id = typeof item.id === "string" ? item.id : "";
    if (!UUID_RE.test(id) || ids.has(id)) return { error: `groups[${i}].id must be a unique uuid` };
    const name = stringValue(item.name, `groups[${i}].name`, 200, false);
    if ("error" in name) return name;
    const color = stringValue(item.color, `groups[${i}].color`, 64);
    if ("error" in color) return color;
    ids.add(id);
    groups.push({ id, name: name.ok, color: color.ok });
  }
  return { ok: groups };
}

function parsePlacement(value: unknown, field: string): ParseResult<WorkspaceTattooPlacement | null> {
  if (value === null) return { ok: null };
  if (!isObject(value)) return { error: `${field} must be null or an object` };
  const keys = ["uvPosX", "uvPosY", "scaleX", "scaleY", "rotation"] as const;
  for (const key of keys) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      return { error: `${field}.${key} must be a finite number` };
    }
  }
  return { ok: value as unknown as WorkspaceTattooPlacement };
}

function parseTattoos(value: unknown): ParseResult<WorkspaceTattoo[]> {
  if (!Array.isArray(value) || value.length > 5_000) return { error: "tattoos must be an array (max 5000)" };
  const tattoos: WorkspaceTattoo[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const field = `tattoos[${i}]`;
    if (!isObject(item)) return { error: `${field} must be an object` };
    const id = typeof item.id === "string" ? item.id : "";
    if (!UUID_RE.test(id) || ids.has(id)) return { error: `${field}.id must be a unique uuid` };
    const label = stringValue(item.label, `${field}.label`, 200);
    if ("error" in label) return label;
    const groupId = nullableString(item.groupId ?? null, `${field}.groupId`, 64);
    if ("error" in groupId) return groupId;
    if (typeof item.zone !== "string" || !TATTOO_ZONES.has(item.zone)) return { error: `${field}.zone is invalid` };
    if (item.type !== "tattoo" && item.type !== "badge") return { error: `${field}.type is invalid` };
    if (item.gender !== "both" && item.gender !== "male" && item.gender !== "female") return { error: `${field}.gender is invalid` };
    const nameMale = nullableString(item.nameMale ?? null, `${field}.nameMale`, 200);
    if ("error" in nameMale) return nameMale;
    const nameFemale = nullableString(item.nameFemale ?? null, `${field}.nameFemale`, 200);
    if ("error" in nameFemale) return nameFemale;
    const image = parseAsset(item.image ?? null, `${field}.image`);
    if ("error" in image) return image;
    const garment = stringValue(item.garment, `${field}.garment`, 200);
    if ("error" in garment) return garment;
    const textLabel = stringValue(item.textLabel, `${field}.textLabel`, 200);
    if ("error" in textLabel) return textLabel;
    const eFacing = nullableString(item.eFacing ?? null, `${field}.eFacing`, 200);
    if ("error" in eFacing) return eFacing;
    if (typeof item.cost !== "number" || !Number.isInteger(item.cost) || item.cost < 0) return { error: `${field}.cost must be a non-negative integer` };
    const placement = parsePlacement(item.placement ?? null, `${field}.placement`);
    if ("error" in placement) return placement;
    ids.add(id);
    tattoos.push({
      id,
      label: label.ok,
      groupId: groupId.ok,
      zone: item.zone as WorkspaceTattoo["zone"],
      type: item.type,
      gender: item.gender,
      nameMale: nameMale.ok,
      nameFemale: nameFemale.ok,
      image: image.ok,
      garment: garment.ok,
      textLabel: textLabel.ok,
      eFacing: eFacing.ok,
      cost: item.cost,
      placement: placement.ok,
    });
  }
  return { ok: tattoos };
}

/** Validate and normalize a complete workspace project. */
export function parseWorkspaceProject(value: unknown): ParseResult<WorkspaceProject> {
  if (!isObject(value)) return { error: "project must be an object" };
  const id = typeof value.id === "string" ? value.id : "";
  if (!UUID_RE.test(id)) return { error: "project.id must be a uuid" };
  const name = stringValue(value.name, "project.name", 100, false);
  if ("error" in name) return name;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return { error: "project.createdAt must be an ISO timestamp" };
  if (!isObject(value.settings)) return { error: "project.settings must be an object" };
  const dlcName = typeof value.settings.dlcName === "string" ? value.settings.dlcName.toLowerCase() : "";
  if (!/^[a-z0-9_]{1,32}$/u.test(dlcName)) return { error: "project.settings.dlcName is invalid" };
  if (value.settings.defaultGender !== "male" && value.settings.defaultGender !== "female") return { error: "project.settings.defaultGender is invalid" };
  const groups = parseGroups(value.groups);
  if ("error" in groups) return groups;
  const drawables = parseRevisionDrawables(value.drawables);
  if ("error" in drawables) return drawables;
  if (!isObject(value.tattooCollection)) return { error: "project.tattooCollection must be an object" };
  const collectionName = typeof value.tattooCollection.name === "string" ? value.tattooCollection.name : "";
  if (!/^[a-z0-9_]{1,64}$/u.test(collectionName)) return { error: "project.tattooCollection.name is invalid" };
  const collectionLabel = stringValue(value.tattooCollection.label, "project.tattooCollection.label", 200);
  if ("error" in collectionLabel) return collectionLabel;
  const tattoos = parseTattoos(value.tattoos);
  if ("error" in tattoos) return tattoos;

  const groupIds = new Set(groups.ok.map((g) => g.id));
  for (const d of drawables.ok) {
    if (d.groupId !== null && !groupIds.has(d.groupId)) {
      return { error: `drawable ${d.id} references an unknown group` };
    }
  }
  for (const t of tattoos.ok) {
    if (t.groupId !== null && !groupIds.has(t.groupId)) {
      return { error: `tattoo ${t.id} references an unknown group` };
    }
  }

  return {
    ok: {
      id,
      name: name.ok,
      createdAt: value.createdAt,
      settings: { dlcName, defaultGender: value.settings.defaultGender },
      groups: groups.ok,
      drawables: drawables.ok,
      tattooCollection: { name: collectionName, label: collectionLabel.ok },
      tattoos: tattoos.ok,
    },
  };
}

/** Every distinct CAS hash referenced by the full live project. */
export function collectWorkspaceSha256s(project: WorkspaceProject): string[] {
  const shas = new Set(collectReferencedSha256s(project.drawables));
  for (const tattoo of project.tattoos) if (tattoo.image) shas.add(tattoo.image.sha256);
  return [...shas];
}

/** Strict outer-shape validation for an untrusted live operation. */
export function parseWorkspaceOperation(value: unknown): ParseResult<WorkspaceOperation> {
  if (!isObject(value) || typeof value.kind !== "string") return { error: "operation must be an object" };
  if (value.kind === "batch") {
    if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > 1_000) {
      return { error: "batch must contain 1..1000 operations" };
    }
    const operations: WorkspaceLeafOperation[] = [];
    for (let i = 0; i < value.operations.length; i++) {
      const parsed = parseWorkspaceOperation(value.operations[i]);
      if ("error" in parsed) return { error: `operations[${i}]: ${parsed.error}` };
      if (parsed.ok.kind === "batch") return { error: "nested batches are not allowed" };
      operations.push(parsed.ok);
    }
    return { ok: { kind: "batch", operations } };
  }
  if (value.kind === "project.patch") {
    if (!isObject(value.patch)) return { error: "project.patch.patch must be an object" };
    if (containsUnsafeObjectKey(value.patch)) return { error: "project.patch contains an unsafe field" };
    const allowed = new Set(["name", "settings", "tattooCollection"]);
    if (Object.keys(value.patch).some((key) => !allowed.has(key))) return { error: "project.patch contains an unknown field" };
    return {
      ok: {
        kind: "project.patch",
        patch: value.patch as Extract<WorkspaceLeafOperation, { kind: "project.patch" }>["patch"],
      },
    };
  }
  const entityType = value.entityType;
  if (entityType !== "group" && entityType !== "drawable" && entityType !== "tattoo") {
    return { error: "operation.entityType is invalid" };
  }
  if (value.kind === "entity.upsert") {
    if (!isObject(value.entity)) return { error: "entity.upsert.entity must be an object" };
    if (containsUnsafeObjectKey(value.entity)) return { error: "entity.upsert contains an unsafe field" };
    return { ok: { kind: "entity.upsert", entityType, entity: value.entity as unknown as WorkspaceGroup } };
  }
  if (value.kind === "entity.patch") {
    if (typeof value.id !== "string" || !UUID_RE.test(value.id) || !isObject(value.patch)) {
      return { error: "entity.patch requires a uuid id and object patch" };
    }
    if (containsUnsafeObjectKey(value.patch)) return { error: "entity.patch contains an unsafe field" };
    if ("id" in value.patch) return { error: "entity.patch may not change id" };
    return { ok: { kind: "entity.patch", entityType, id: value.id, patch: value.patch } };
  }
  if (value.kind === "entity.delete") {
    if (typeof value.id !== "string" || !UUID_RE.test(value.id)) return { error: "entity.delete.id must be a uuid" };
    return { ok: { kind: "entity.delete", entityType, id: value.id } };
  }
  if (value.kind === "order.set") {
    if (entityType === "group" || !Array.isArray(value.ids) || value.ids.length > 5_000) {
      return { error: "order.set requires drawable|tattoo and at most 5000 ids" };
    }
    const ids: string[] = [];
    for (const id of value.ids) {
      if (typeof id !== "string" || !UUID_RE.test(id)) return { error: "order.set ids must be uuids" };
      if (!ids.includes(id)) ids.push(id);
    }
    return { ok: { kind: "order.set", entityType, ids } };
  }
  return { error: "unknown operation kind" };
}

function mergePatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(out[key])) out[key] = mergePatch(out[key] as Record<string, unknown>, value);
    else out[key] = value;
  }
  return out;
}

function applyLeaf(project: WorkspaceProject, op: WorkspaceLeafOperation): WorkspaceProject {
  const next = structuredClone(project);
  if (op.kind === "project.patch") {
    if (op.patch.name !== undefined) next.name = op.patch.name;
    if (op.patch.settings !== undefined) next.settings = { ...next.settings, ...op.patch.settings };
    if (op.patch.tattooCollection !== undefined) next.tattooCollection = { ...next.tattooCollection, ...op.patch.tattooCollection };
    return next;
  }

  const key = op.entityType === "group" ? "groups" : op.entityType === "drawable" ? "drawables" : "tattoos";
  const list = next[key] as Array<{ id: string }>;

  if (op.kind === "entity.delete") {
    (next as unknown as Record<string, unknown>)[key] = list.filter((item) => item.id !== op.id);
    if (op.entityType === "group") {
      next.drawables = next.drawables.map((d) => (d.groupId === op.id ? { ...d, groupId: null } : d));
      next.tattoos = next.tattoos.map((t) => (t.groupId === op.id ? { ...t, groupId: null } : t));
    }
    return next;
  }

  if (op.kind === "entity.upsert") {
    const entity = op.entity as { id: string };
    const index = list.findIndex((item) => item.id === entity.id);
    if (index === -1) list.push(entity);
    else list[index] = entity;
    return next;
  }

  if (op.kind === "entity.patch") {
    const index = list.findIndex((item) => item.id === op.id);
    if (index === -1) return next; // delete wins over a stale edit
    list[index] = mergePatch(list[index] as unknown as Record<string, unknown>, op.patch) as unknown as { id: string };
    list[index]!.id = op.id;
    return next;
  }

  // order.set: preserve concurrently added ids that were absent from the
  // sender's view, appending them in their current authoritative order.
  const byId = new Map(list.map((item) => [item.id, item]));
  const ordered: Array<{ id: string }> = [];
  const used = new Set<string>();
  for (const id of op.ids) {
    const item = byId.get(id);
    if (item && !used.has(id)) {
      ordered.push(item);
      used.add(id);
    }
  }
  for (const item of list) if (!used.has(item.id)) ordered.push(item);
  (next as unknown as Record<string, unknown>)[key] = ordered;
  return next;
}

/** Apply one operation and revalidate the complete result. */
export function applyWorkspaceOperation(project: WorkspaceProject, operation: WorkspaceOperation): ParseResult<WorkspaceProject> {
  const operations = operation.kind === "batch" ? operation.operations : [operation];
  if (operations.length === 0 || operations.length > 1_000) return { error: "batch must contain 1..1000 operations" };
  let next = project;
  for (const op of operations) next = applyLeaf(next, op);
  return parseWorkspaceProject(next);
}

export function publicWorkspace(workspace: AtelierWorkspace) {
  return {
    packId: workspace.packId,
    schemaVersion: workspace.schemaVersion,
    version: workspace.version,
    project: workspace.project,
    updatedAt: workspace.updatedAt,
    updatedByDiscordId: workspace.updatedByDiscordId,
  };
}
