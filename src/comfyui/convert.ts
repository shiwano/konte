import { KonteError } from "../core/errors.js";
import type { ComfyUIInputSpec, ComfyUINodeDefinition, ComfyUIWorkflow } from "./types.js";

type LitegraphLink = [
  linkId: number,
  sourceNodeId: number,
  sourceSlotIndex: number,
  targetNodeId: number,
  targetSlotIndex: number,
  type: string,
];

type LitegraphNode = {
  id: number;
  type: string;
  inputs?: { name: string; type: string; link: number | null; label?: string; widget?: unknown }[];
  outputs?: { name: string; type: string; links: number[] | null }[];
  widgets_values?: unknown[] | Record<string, unknown>;
  mode?: number;
  properties?: Record<string, unknown>;
};

type SubgraphLink = {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
  type: string;
};

type SubgraphDefinition = {
  id: string;
  inputNode: { id: number };
  outputNode: { id: number };
  inputs: { name: string; type: string; linkIds: number[] }[];
  outputs: { name: string; type: string; linkIds: number[] }[];
  nodes: LitegraphNode[];
  links: SubgraphLink[];
};

export type LitegraphWorkflow = {
  last_node_id: number;
  last_link_id: number;
  nodes: LitegraphNode[];
  links: LitegraphLink[];
  definitions?: {
    subgraphs?: SubgraphDefinition[];
  };
};

export type SubgraphMeta = {
  internalNodeIds: Set<string>;
  inputTargetKeys: Set<string>;
  // Each entry lists the `{nodeId, field}` targets that were all fed by a single
  // litegraph PrimitiveNode. Inlining copies the primitive's value into every
  // consumer, so these inputs must move together — the adapter generator collapses
  // each group into one input (with the rest as `also` targets).
  sharedPrimitiveGroups: { nodeId: string; field: string }[][];
};

const SKIP_NODE_TYPES = new Set([
  "Note",
  "MarkdownNote",
  "Reroute",
  "PrimitiveNode",
  "SetNode",
  "GetNode",
]);
const BYPASSED_MODE = 4;

export function flattenSubgraphs(workflow: LitegraphWorkflow): {
  workflow: LitegraphWorkflow;
  subgraphMeta: SubgraphMeta;
} {
  const subgraphs = workflow.definitions?.subgraphs;
  const meta: SubgraphMeta = {
    internalNodeIds: new Set(),
    inputTargetKeys: new Set(),
    sharedPrimitiveGroups: [],
  };
  if (!subgraphs?.length) return { workflow, subgraphMeta: meta };

  const subgraphMap = new Map<string, SubgraphDefinition>();
  for (const sg of subgraphs) {
    subgraphMap.set(sg.id, sg);
  }

  let nodes = [...workflow.nodes];
  let links = [...workflow.links];
  let lastNodeId = workflow.last_node_id;
  let lastLinkId = workflow.last_link_id;

  let firstPass = true;
  let changed = true;
  while (changed) {
    const result = expandSubgraphNodes(
      nodes,
      links,
      subgraphMap,
      lastNodeId,
      lastLinkId,
      firstPass ? meta : undefined,
    );
    changed = result !== null;
    if (result) {
      ({ nodes, links, lastNodeId, lastLinkId } = result);
      for (const id of result.expandedNodeIds) {
        meta.internalNodeIds.add(String(id));
      }
    }
    firstPass = false;
  }

  return {
    workflow: { last_node_id: lastNodeId, last_link_id: lastLinkId, nodes, links },
    subgraphMeta: meta,
  };
}

function expandSubgraphNodes(
  nodes: LitegraphNode[],
  links: LitegraphLink[],
  subgraphMap: Map<string, SubgraphDefinition>,
  lastNodeId: number,
  lastLinkId: number,
  inputTargetMeta?: SubgraphMeta,
): {
  nodes: LitegraphNode[];
  links: LitegraphLink[];
  lastNodeId: number;
  lastLinkId: number;
  expandedNodeIds: number[];
} | null {
  const subgraphNodes = nodes.filter((n) => subgraphMap.has(n.type));
  if (subgraphNodes.length === 0) return null;

  let nextNodeId = lastNodeId + 1;
  let nextLinkId = lastLinkId + 1;

  const linkMap = new Map<number, LitegraphLink>();
  for (const link of links) {
    linkMap.set(link[0], link);
  }

  const subgraphNodeIds = new Set(subgraphNodes.map((n) => n.id));
  const allOutputRemaps = new Map<number, Map<number, [number, number]>>();
  const allExpandedNodes: LitegraphNode[] = [];
  const allExpandedLinks: LitegraphLink[] = [];
  const expandedNodeIds: number[] = [];

  for (const sgNode of subgraphNodes) {
    const sgDef = subgraphMap.get(sgNode.type)!;

    const nodeIdMap = new Map<number, number>();
    for (const internalNode of sgDef.nodes) {
      nodeIdMap.set(internalNode.id, nextNodeId++);
    }
    for (const remappedId of nodeIdMap.values()) {
      expandedNodeIds.push(remappedId);
    }

    const parentInputLinkByName = new Map<string, LitegraphLink>();
    if (sgNode.inputs) {
      for (const input of sgNode.inputs) {
        if (input.link != null) {
          const parentLink = linkMap.get(input.link);
          if (parentLink) {
            parentInputLinkByName.set(input.name, parentLink);
          }
        }
      }
    }

    const copiedNodes = new Map<number, LitegraphNode>();
    for (const internalNode of sgDef.nodes) {
      const newId = nodeIdMap.get(internalNode.id)!;
      copiedNodes.set(newId, {
        ...internalNode,
        id: newId,
        inputs: internalNode.inputs?.map((inp) => ({ ...inp })),
        outputs: internalNode.outputs?.map((out) => ({
          ...out,
          links: out.links ? [...out.links] : null,
        })),
        widgets_values: Array.isArray(internalNode.widgets_values)
          ? [...internalNode.widgets_values]
          : internalNode.widgets_values && { ...internalNode.widgets_values },
      });
    }

    const outputRemap = new Map<number, [number, number]>();
    const inputNodeId = sgDef.inputNode.id;
    const outputNodeId = sgDef.outputNode.id;

    for (const iLink of sgDef.links) {
      if (iLink.origin_id === inputNodeId) {
        const sgInput = sgDef.inputs[iLink.origin_slot];
        const parentLink = sgInput ? parentInputLinkByName.get(sgInput.name) : undefined;
        const remappedTargetId = nodeIdMap.get(iLink.target_id);
        if (remappedTargetId == null) continue;
        const targetNode = copiedNodes.get(remappedTargetId);
        const targetInputEntry = targetNode?.inputs?.find((i) => i.link === iLink.id);

        if (inputTargetMeta && sgInput && targetInputEntry) {
          const origNode = sgDef.nodes.find((n) => n.id === iLink.target_id);
          if (origNode && !subgraphMap.has(origNode.type)) {
            inputTargetMeta.inputTargetKeys.add(`${remappedTargetId}:${targetInputEntry.name}`);
          }
        }

        if (parentLink) {
          const newLinkId = nextLinkId++;
          allExpandedLinks.push([
            newLinkId,
            parentLink[1],
            parentLink[2],
            remappedTargetId,
            iLink.target_slot,
            iLink.type,
          ]);
          if (targetInputEntry) targetInputEntry.link = newLinkId;
        } else {
          if (targetInputEntry) targetInputEntry.link = null;
        }
      } else if (iLink.target_id === outputNodeId) {
        const remappedOriginId = nodeIdMap.get(iLink.origin_id);
        if (remappedOriginId != null) {
          outputRemap.set(iLink.target_slot, [remappedOriginId, iLink.origin_slot]);
        }
      } else {
        const remappedOriginId = nodeIdMap.get(iLink.origin_id);
        const remappedTargetId = nodeIdMap.get(iLink.target_id);
        if (remappedOriginId == null || remappedTargetId == null) continue;

        const newLinkId = nextLinkId++;
        allExpandedLinks.push([
          newLinkId,
          remappedOriginId,
          iLink.origin_slot,
          remappedTargetId,
          iLink.target_slot,
          iLink.type,
        ]);
        const targetNode = copiedNodes.get(remappedTargetId);
        if (targetNode?.inputs) {
          const inp = targetNode.inputs.find((i) => i.link === iLink.id);
          if (inp) inp.link = newLinkId;
        }
      }
    }

    allOutputRemaps.set(sgNode.id, outputRemap);
    for (const [, node] of copiedNodes) {
      allExpandedNodes.push(node);
    }
  }

  const keptNodes = nodes.filter((n) => !subgraphNodeIds.has(n.id));

  const rewrittenLinks: LitegraphLink[] = [];
  for (const link of links) {
    const [linkId, srcId, srcSlot, tgtId, tgtSlot, type] = link;
    if (subgraphNodeIds.has(srcId)) {
      const remap = allOutputRemaps.get(srcId)?.get(srcSlot);
      if (remap) {
        rewrittenLinks.push([linkId, remap[0], remap[1], tgtId, tgtSlot, type]);
      }
    } else if (subgraphNodeIds.has(tgtId)) {
      // Handled during expansion
    } else {
      rewrittenLinks.push(link);
    }
  }

  return {
    nodes: [...keptNodes, ...allExpandedNodes],
    links: [...rewrittenLinks, ...allExpandedLinks],
    lastNodeId: nextNodeId - 1,
    lastLinkId: nextLinkId - 1,
    expandedNodeIds,
  };
}

// Node types a flattened workflow runs that the ComfyUI server does not serve.
export function findUnknownNodeTypes(
  flat: LitegraphWorkflow,
  objectInfo: Record<string, ComfyUINodeDefinition>,
): string[] {
  return [
    ...new Set(
      flat.nodes
        .filter((n) => !SKIP_NODE_TYPES.has(n.type) && n.mode !== BYPASSED_MODE)
        .map((n) => n.type)
        .filter((type) => !objectInfo[type]),
    ),
  ];
}

export function convertLitegraphToApi(
  litegraph: LitegraphWorkflow,
  objectInfo: Record<string, ComfyUINodeDefinition>,
): { workflow: ComfyUIWorkflow; subgraphMeta: SubgraphMeta } {
  const { workflow: flat, subgraphMeta } = flattenSubgraphs(litegraph);

  const linkMap = new Map<number, LitegraphLink>();
  for (const link of flat.links) {
    linkMap.set(link[0], link);
  }

  const rerouteInputLinks = new Map<number, number | null>();
  // KJNodes Set/Get are frontend-only virtual nodes: a GetNode mirrors the value a
  // same-named SetNode received, with no litegraph link between them. They carry no
  // backend node, so resolve a GetNode's output to its SetNode's input source.
  const setNodeInputLinkByName = new Map<string, number | null>();
  const getNodeNamesById = new Map<number, string>();
  // Legacy virtual primitives carry no backend node; their first widget value is
  // inlined into whichever widget input they feed (matching ComfyUI's native API export).
  const primitiveValues = new Map<number, unknown>();
  for (const node of flat.nodes) {
    const firstWidget = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
    if (node.type === "Reroute") {
      rerouteInputLinks.set(node.id, node.inputs?.[0]?.link ?? null);
    } else if (node.type === "SetNode") {
      if (typeof firstWidget === "string")
        setNodeInputLinkByName.set(firstWidget, node.inputs?.[0]?.link ?? null);
    } else if (node.type === "GetNode") {
      if (typeof firstWidget === "string") getNodeNamesById.set(node.id, firstWidget);
    } else if (node.type === "PrimitiveNode") {
      primitiveValues.set(node.id, firstWidget);
    }
  }

  function resolveSource(
    nodeId: number,
    slotIndex: number,
    seen: Set<number> = new Set(),
  ): [number, number] {
    if (seen.has(nodeId)) return [nodeId, slotIndex];

    if (rerouteInputLinks.has(nodeId)) {
      seen.add(nodeId);
      const inputLinkId = rerouteInputLinks.get(nodeId);
      if (inputLinkId == null) return [nodeId, slotIndex];
      const link = linkMap.get(inputLinkId);
      if (!link) return [nodeId, slotIndex];
      return resolveSource(link[1], link[2], seen);
    }

    const getName = getNodeNamesById.get(nodeId);
    if (getName !== undefined) {
      seen.add(nodeId);
      const setLinkId = setNodeInputLinkByName.get(getName);
      if (setLinkId == null) return [nodeId, slotIndex];
      const link = linkMap.get(setLinkId);
      if (!link) return [nodeId, slotIndex];
      return resolveSource(link[1], link[2], seen);
    }

    return [nodeId, slotIndex];
  }

  const unknownTypes = findUnknownNodeTypes(flat, objectInfo);
  if (unknownTypes.length > 0) {
    throw new KonteError(
      "WORKFLOW_IMPORT_FAILED",
      `The ComfyUI server has no node type ${unknownTypes.map((t) => `"${t}"`).join(", ")}. ` +
        "Install the custom node pack that provides each (or update ComfyUI, for a core node), " +
        "restart ComfyUI, and import again.",
    );
  }

  const result: ComfyUIWorkflow = {};

  // Targets that received an inlined value from the same PrimitiveNode, keyed by
  // primitive node id; groups with >1 target are surfaced via subgraphMeta.
  const sharedTargetsByPrimitive = new Map<number, { nodeId: string; field: string }[]>();

  for (const node of flat.nodes) {
    if (SKIP_NODE_TYPES.has(node.type)) continue;
    if (node.mode === BYPASSED_MODE) continue;

    const nodeDef = objectInfo[node.type]!;

    const linkedInputNames = new Set<string>();
    const slotInputNames = new Set<string>();
    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link != null) {
          linkedInputNames.add(input.name);
        }
        if (input.widget == null) {
          slotInputNames.add(input.name);
        }
      }
    }

    const inputDefs = collectInputDefs(nodeDef);

    const dynamicSubWidgets = new Map<string, string[]>();
    if (node.inputs) {
      for (const input of node.inputs) {
        if (!input.widget || inputDefs.has(input.name)) continue;
        // The frontend's upload button, serialized as a widget input by newer frontends.
        if (input.type.endsWith("UPLOAD")) continue;
        const dotIdx = input.name.lastIndexOf(".");
        if (dotIdx < 0) {
          throw new KonteError(
            "WORKFLOW_IMPORT_FAILED",
            `Node ${node.id} ("${node.type}") has widget input "${input.name}", which the ` +
              `ComfyUI server's definition of "${node.type}" does not declare.`,
          );
        }
        const parent = input.name.substring(0, dotIdx);
        if (!inputDefs.has(parent)) {
          throw new KonteError(
            "WORKFLOW_IMPORT_FAILED",
            `Node ${node.id} ("${node.type}") has sub-widget "${input.name}", but the ComfyUI ` +
              `server's definition of "${node.type}" declares no "${parent}".`,
          );
        }
        let subs = dynamicSubWidgets.get(parent);
        if (!subs) {
          subs = [];
          dynamicSubWidgets.set(parent, subs);
        }
        subs.push(input.name);
      }
    }

    const inputs: Record<string, unknown> = {};

    const widgets = node.widgets_values;
    if (Array.isArray(widgets)) {
      let widgetIdx = 0;
      const assignWidget = (fieldName: string, def: ComfyUIInputSpec, isSub = false): void => {
        if (widgetIdx >= widgets.length) return;
        const typeName = def[0];
        const value = widgets[widgetIdx];
        if (!linkedInputNames.has(fieldName)) {
          inputs[fieldName] = value;
        }
        widgetIdx++;

        // A dynamic combo's sub-widgets store no companion control value.
        if (!isSub) {
          // "IMAGEUPLOAD" and "VIDEOUPLOAD" types store an extra control widget value after the seed
          if (typeName === "IMAGEUPLOAD" || typeName === "VIDEOUPLOAD") {
            widgetIdx++;
          }
          // Seed-type inputs have an extra control_after_generate widget
          if (typeName === "INT" && isSeedInput(fieldName, def)) {
            widgetIdx++;
          }
          widgetIdx += uploadCompanionWidgetCount(def);
        }

        if (typeName === "COMFY_DYNAMICCOMBO_V3") {
          for (const [sub, subDef] of getDynamicComboSubInputs(fieldName, value, def)) {
            if (isWidgetSpec(subDef)) assignWidget(sub, subDef, true);
          }
          return;
        }
        for (const sub of dynamicSubWidgets.get(fieldName) ?? []) {
          if (widgetIdx >= widgets.length) break;
          if (!linkedInputNames.has(sub)) {
            inputs[sub] = widgets[widgetIdx];
          }
          widgetIdx++;
        }
      };
      for (const [fieldName, def] of inputDefs) {
        // An autogrow input appears in `node.inputs` only by its expanded `<name>.<slot>` sockets.
        if (slotInputNames.has(fieldName) || def[0] === "COMFY_AUTOGROW_V3") continue;
        assignWidget(fieldName, def);
      }
    } else if (widgets) {
      // VideoHelperSuite nodes store widget values keyed by input name.
      for (const fieldName of inputDefs.keys()) {
        if (slotInputNames.has(fieldName) || linkedInputNames.has(fieldName)) continue;
        if (fieldName in widgets) inputs[fieldName] = widgets[fieldName];
      }
    }

    // A template saved before the node grew a required widget carries no value for it; the
    // frontend would fill it on load, so the conversion does too.
    for (const [fieldName, def] of Object.entries(nodeDef.input.required ?? {})) {
      if (fieldName in inputs || slotInputNames.has(fieldName) || linkedInputNames.has(fieldName)) {
        continue;
      }
      const value = widgetDefaultValue(def);
      if (value !== undefined) inputs[fieldName] = value;
    }

    if (node.inputs) {
      for (const input of node.inputs) {
        if (input.link == null) continue;
        const link = linkMap.get(input.link);
        if (!link) continue;
        const [resolvedNodeId, resolvedSlot] = resolveSource(link[1], link[2]);
        if (primitiveValues.has(resolvedNodeId)) {
          const value = primitiveValues.get(resolvedNodeId);
          if (value !== undefined) {
            inputs[input.name] = value;
            const targets = sharedTargetsByPrimitive.get(resolvedNodeId) ?? [];
            targets.push({ nodeId: String(node.id), field: input.name });
            sharedTargetsByPrimitive.set(resolvedNodeId, targets);
            continue;
          }
        }
        inputs[input.name] = [String(resolvedNodeId), resolvedSlot];
      }
    }

    result[String(node.id)] = {
      class_type: node.type,
      inputs,
    };
  }

  for (const targets of sharedTargetsByPrimitive.values()) {
    if (targets.length > 1) subgraphMeta.sharedPrimitiveGroups.push(targets);
  }

  return { workflow: result, subgraphMeta };
}

function collectInputDefs(nodeDef: ComfyUINodeDefinition): Map<string, ComfyUIInputSpec> {
  const result = new Map<string, ComfyUIInputSpec>();

  if (nodeDef.input.required) {
    for (const [name, def] of Object.entries(nodeDef.input.required)) {
      result.set(name, def);
    }
  }

  if (nodeDef.input.optional) {
    for (const [name, def] of Object.entries(nodeDef.input.optional)) {
      result.set(name, def);
    }
  }

  return result;
}

function getDynamicComboSubInputs(
  fieldName: string,
  value: unknown,
  def: ComfyUIInputSpec,
): [string, ComfyUIInputSpec][] {
  const config = def[1];
  if (typeof config !== "object" || config === null) return [];
  const options = (config as Record<string, unknown>).options;
  if (!Array.isArray(options)) return [];

  for (const opt of options) {
    if (typeof opt !== "object" || opt === null) continue;
    const optObj = opt as Record<string, unknown>;
    if (optObj.key !== value) continue;
    const optInputs = optObj.inputs;
    if (typeof optInputs !== "object" || optInputs === null) return [];
    const subs: [string, ComfyUIInputSpec][] = [];
    for (const section of ["required", "optional"]) {
      const sectionObj = (optInputs as Record<string, unknown>)[section];
      if (typeof sectionObj !== "object" || sectionObj === null) continue;
      for (const [subName, subDef] of Object.entries(sectionObj as Record<string, unknown>)) {
        subs.push([`${fieldName}.${subName}`, subDef as ComfyUIInputSpec]);
      }
    }
    return subs;
  }
  return [];
}

const WIDGET_TYPES = new Set([
  "INT",
  "FLOAT",
  "STRING",
  "BOOLEAN",
  "COMBO",
  "COMFY_DYNAMICCOMBO_V3",
]);

// A dynamic combo option lists its sockets (IMAGE, autogrow, …) beside its widgets; only a
// widget holds a slot in `widgets_values`.
function isWidgetSpec(def: ComfyUIInputSpec): boolean {
  const [type, config] = def;
  if (typeof config === "object" && config !== null && "forceInput" in config) {
    if ((config as Record<string, unknown>).forceInput === true) return false;
  }
  return Array.isArray(type) || (typeof type === "string" && WIDGET_TYPES.has(type));
}

// Widgets the frontend appends after an upload combo: an upload button, plus an audio preview
// for audio and the extra-resources and clear buttons for a 3D model.
const UPLOAD_COMPANION_WIDGETS: Record<string, number> = {
  image_upload: 1,
  video_upload: 1,
  audio_upload: 2,
  file_upload: 3,
};

function uploadCompanionWidgetCount(def: ComfyUIInputSpec): number {
  const [type, config] = def;
  if (!Array.isArray(type) && type !== "COMBO") return 0;
  if (typeof config !== "object" || config === null) return 0;
  for (const [flag, count] of Object.entries(UPLOAD_COMPANION_WIDGETS)) {
    if ((config as Record<string, unknown>)[flag] === true) return count;
  }
  return 0;
}

function widgetDefaultValue(def: ComfyUIInputSpec): unknown {
  const [type, config] = def;
  if (!Array.isArray(type) && (typeof type !== "string" || !WIDGET_TYPES.has(type))) {
    return undefined;
  }
  if (type === "COMFY_DYNAMICCOMBO_V3") return undefined;
  const cfg =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  if (cfg.forceInput === true) return undefined;
  if (cfg.default !== undefined) return cfg.default;
  const options = Array.isArray(type) ? type : cfg.options;
  return Array.isArray(options) ? options[0] : undefined;
}

function isSeedInput(fieldName: string, def: ComfyUIInputSpec): boolean {
  const name = fieldName.toLowerCase();
  if (name === "seed" || name === "noise_seed") return true;

  const config = def[1];
  if (
    typeof config === "object" &&
    config !== null &&
    "max" in (config as Record<string, unknown>)
  ) {
    const max = (config as Record<string, unknown>).max;
    return typeof max === "number" && max >= 0xffff_ffff_ffff;
  }
  return false;
}
