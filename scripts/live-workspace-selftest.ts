/** Pure reducer/validator checks for the durable realtime workspace. */

import {
  applyWorkspaceOperation,
  collectWorkspaceSha256s,
  parseWorkspaceOperation,
  parseWorkspaceProject,
  type WorkspaceProject,
} from "../src/models/atelierWorkspace";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

function apply(project: WorkspaceProject, operation: Parameters<typeof applyWorkspaceOperation>[1]) {
  const result = applyWorkspaceOperation(project, operation);
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

const projectId = "00000000-0000-4000-8000-000000000001";
const groupId = "00000000-0000-4000-8000-000000000002";
const drawableA = "00000000-0000-4000-8000-000000000003";
const drawableB = "00000000-0000-4000-8000-000000000004";
const tattooId = "00000000-0000-4000-8000-000000000005";
const assetSha = "ab".repeat(32);

const empty: WorkspaceProject = {
  id: projectId,
  name: "Live Pack",
  createdAt: "2026-08-20T00:00:00.000Z",
  settings: { dlcName: "live_pack", defaultGender: "male" },
  groups: [{ id: groupId, name: "Tops", color: "#5865F2" }],
  drawables: [],
  tattooCollection: { name: "live_pack", label: "Tattoos" },
  tattoos: [],
};

check("complete workspace validates", "ok" in parseWorkspaceProject(empty));
check(
  "unknown operation is rejected",
  "error" in parseWorkspaceOperation({ kind: "explode" }),
);
check(
  "prototype-polluting patches are rejected",
  "error" in parseWorkspaceOperation(
    JSON.parse('{"kind":"entity.patch","entityType":"drawable","id":"00000000-0000-4000-8000-000000000003","patch":{"__proto__":{"polluted":true}}}'),
  ),
);

const drawable = (id: string, label: string) => ({
  id,
  gender: "male" as const,
  kind: "component" as const,
  type: "jbib" as const,
  mode: "addon" as const,
  replaceTargetId: null,
  label,
  groupId,
  ydd: null,
  textures: [],
  physics: null,
  firstPerson: null,
  flags: { highHeels: false, hairScaleValue: null },
});

let current = apply(empty, {
  kind: "batch",
  operations: [
    { kind: "entity.upsert", entityType: "drawable", entity: drawable(drawableA, "A") },
    { kind: "entity.upsert", entityType: "drawable", entity: drawable(drawableB, "B") },
  ],
});
check("batch upserts both stable-id entities", current.drawables.length === 2);

current = apply(current, {
  kind: "entity.patch",
  entityType: "drawable",
  id: drawableA,
  patch: { label: "A remote", flags: { hairScaleValue: 0.5 } },
});
current = apply(current, {
  kind: "entity.patch",
  entityType: "drawable",
  id: drawableA,
  patch: { flags: { highHeels: true } },
});
const patched = current.drawables.find((item) => item.id === drawableA)!;
check(
  "field patches merge without losing sibling fields",
  patched.label === "A remote" &&
    patched.flags.hairScaleValue === 0.5 &&
    patched.flags.highHeels,
);

current = apply(current, {
  kind: "order.set",
  entityType: "drawable",
  ids: [drawableB],
});
check(
  "reorder preserves concurrently unknown entities",
  current.drawables.map((item) => item.id).join(",") === `${drawableB},${drawableA}`,
);

current = apply(current, {
  kind: "entity.delete",
  entityType: "drawable",
  id: drawableA,
});
current = apply(current, {
  kind: "entity.patch",
  entityType: "drawable",
  id: drawableA,
  patch: { label: "stale edit" },
});
check(
  "delete wins over a stale patch",
  !current.drawables.some((item) => item.id === drawableA),
);

current = apply(current, {
  kind: "entity.upsert",
  entityType: "tattoo",
  entity: {
    id: tattooId,
    label: "Ink",
    groupId,
    zone: "torso",
    type: "tattoo",
    gender: "both",
    nameMale: null,
    nameFemale: null,
    image: { sha256: assetSha, size: 42, exportName: "ink.png" },
    garment: "All",
    textLabel: "",
    eFacing: null,
    cost: 0,
    placement: null,
  },
});
check(
  "tattoo source binaries participate in CAS reachability",
  collectWorkspaceSha256s(current).includes(assetSha),
);

current = apply(current, {
  kind: "entity.delete",
  entityType: "group",
  id: groupId,
});
check(
  "deleting a group clears references atomically",
  current.drawables.every((item) => item.groupId === null) &&
    current.tattoos.every((item) => item.groupId === null),
);
const dangling = structuredClone(current);
dangling.tattoos[0]!.groupId = groupId;
check(
  "dangling group references are rejected instead of normalized differently per client",
  "error" in parseWorkspaceProject(dangling),
);

if (failures.length > 0) {
  throw new Error(`${failures.length} live workspace check(s) failed: ${failures.join(", ")}`);
}
console.log(`All ${passed} live workspace checks passed.`);
