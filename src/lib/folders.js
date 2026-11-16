export const PARENT_PREFIX = "p:";

export const isParentFolder = (f) => !!f && f.kind === "parent";
export const isParentValue = (v) => typeof v === "string" && v.startsWith(PARENT_PREFIX);
export const parentValue = (id) => PARENT_PREFIX + id;
export const parentIdOf = (v) => (isParentValue(v) ? v.slice(PARENT_PREFIX.length) : null);

export function groupFolders(folders) {
  const list = folders || [];
  const parents = new Map();
  for (const f of list) {
    if (isParentFolder(f)) {
      parents.set(f.id, { id: f.id, name: f.name || "Ordnergruppe", icon: f.icon || "📁", order: f.order ?? 0 });
    }
  }
  const leaves = list.filter((f) => !isParentFolder(f));
  for (const f of leaves) {
    if (f.parentId && !parents.has(f.parentId)) {
      parents.set(f.parentId, { id: f.parentId, name: f.parentName || "Ordnergruppe", icon: f.parentIcon || "📁", order: 0 });
    }
  }
  const childrenOf = new Map();
  const ungrouped = [];
  for (const f of leaves) {
    if (f.parentId && parents.has(f.parentId)) {
      if (!childrenOf.has(f.parentId)) childrenOf.set(f.parentId, []);
      childrenOf.get(f.parentId).push(f);
    } else {
      ungrouped.push(f);
    }
  }
  const groups = [...parents.values()]
    .sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name)))
    .map((p) => ({ parent: p, children: childrenOf.get(p.id) || [] }));
  return { groups, ungrouped };
}

export function folderFilterOptions(folders) {
  const { groups, ungrouped } = groupFolders(folders);
  const opts = [];
  for (const { parent, children } of groups) {
    opts.push({ value: parentValue(parent.id), label: `${parent.icon} ${parent.name}` });
    for (const c of children) opts.push({ value: c.id, label: ` ↳ ${c.icon || "📁"} ${c.name}` });
  }
  for (const c of ungrouped) opts.push({ value: c.id, label: `${c.icon || "📁"} ${c.name}` });
  return opts;
}

export function childFolderIds(folders, parentId) {
  const { groups } = groupFolders(folders);
  const grp = groups.find((g) => g.parent.id === parentId);
  return grp ? grp.children.map((c) => c.id) : [];
}

export function resolveFolderScope(folders, value) {
  if (!value || value === "all") return { folderId: null, folderIds: null };
  if (isParentValue(value)) return { folderId: null, folderIds: childFolderIds(folders, parentIdOf(value)) };
  return { folderId: value, folderIds: null };
}

export function matchFolderValue(folders, value, wordFolderId) {
  if (!value || value === "all") return true;
  if (isParentValue(value)) return childFolderIds(folders, parentIdOf(value)).includes(wordFolderId ?? null);
  return (wordFolderId ?? null) === value;
}
