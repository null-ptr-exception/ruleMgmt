#!/usr/bin/env python3
"""
prune_routes.py — Full route-tree pruning for AlertmanagerConfig

Algorithm
---------
1. Strip top-level routeMatchers from every child route (already implicit in
   spec.route.matchers, so repeating them in sub-routes is redundant).
2. Recursively group routes that share a common matcher set:
   - For every unique group of routes reachable via the same shared matcher,
     compute the full intersection of their matchers.
   - Pick the grouping that covers the most routes (ties broken by most
     shared matchers hoisted).
   - Hoist the intersection as a synthetic parent node; children keep only
     their differentiating matchers.
   - Recurse on children, then on any ungrouped routes.

Usage
-----
  # from stdin (JSON)
  echo '{"routeRules":[...], "routeMatchers":[...]}' | python3 scripts/prune_routes.py

  # from file (JSON or YAML)
  python3 scripts/prune_routes.py input.yaml

Output: YAML with keys  routeRules (nested tree)  stats.before / stats.after
"""

import sys
import json
from collections import Counter
from typing import Any, Dict, FrozenSet, List, Optional, Set

try:
    import yaml
except ImportError:
    sys.exit("PyYAML required: pip install pyyaml")

Route   = Dict[str, Any]
Matcher = Dict[str, str]


# ── Matcher identity ──────────────────────────────────────────────────────────

def mkey(m: Matcher) -> str:
    return f"{m['key']}\x00{m.get('op','=')}\x00{m['value']}"


# ── Step 1: strip top-level matchers ─────────────────────────────────────────

def strip_top(routes: List[Route], top: List[Matcher]) -> List[Route]:
    top_keys: Set[str] = {mkey(m) for m in top if m.get("key", "").strip()}
    out = []
    for r in routes:
        ms = [m for m in r.get("matchers", [])
              if m.get("key", "").strip() and mkey(m) not in top_keys]
        if r.get("receiver"):
            out.append({**r, "matchers": ms})
    return out


# ── Step 2: recursive trie grouping ──────────────────────────────────────────

def build_tree(routes: List[Route]) -> List[Route]:
    if len(routes) <= 1:
        return list(routes)

    # Map matcher-key → which route indices contain it
    mk_to_idx: Dict[str, List[int]] = {}
    mk_to_obj: Dict[str, Matcher]   = {}
    for i, r in enumerate(routes):
        for m in r.get("matchers", []):
            k = mkey(m)
            mk_to_idx.setdefault(k, []).append(i)
            mk_to_obj[k] = m

    # Only matchers shared by 2+ routes are candidates for hoisting
    shared_mks = {k for k, idxs in mk_to_idx.items() if len(idxs) >= 2}
    if not shared_mks:
        return list(routes)

    # For each unique group of route indices reachable via a shared matcher,
    # compute the full intersection of matchers across all routes in that group.
    seen_groups: Set[FrozenSet[int]] = set()
    candidates = []

    for k in shared_mks:
        group_idxs = frozenset(mk_to_idx[k])
        if group_idxs in seen_groups:
            continue
        seen_groups.add(group_idxs)

        # Intersection of all matchers across routes in this group
        common: Optional[Set[str]] = None
        for i in group_idxs:
            route_keys = {mkey(m) for m in routes[i].get("matchers", [])}
            common = route_keys if common is None else common & route_keys

        if common:
            candidates.append({
                "indices": sorted(group_idxs),
                "common":  common,
                "score":   (len(group_idxs), len(common)),
            })

    if not candidates:
        return list(routes)

    # Best: most routes grouped, then most matchers hoisted
    best       = max(candidates, key=lambda c: c["score"])
    g_indices  = set(best["indices"])
    common_keys: Set[str] = best["common"]

    # Build the parent node
    parent_matchers = [mk_to_obj[k] for k in common_keys if k in mk_to_obj]

    recv_counter  = Counter(routes[i]["receiver"] for i in best["indices"])
    parent_recv   = recv_counter.most_common(1)[0][0]

    # Children = grouped routes with shared matchers removed
    children_raw: List[Route] = []
    for i in best["indices"]:
        child_ms = [m for m in routes[i].get("matchers", [])
                    if mkey(m) not in common_keys]
        # Drop child if identical to parent (no extra matchers + same receiver)
        if not child_ms and routes[i]["receiver"] == parent_recv:
            continue
        children_raw.append({"receiver": routes[i]["receiver"], "matchers": child_ms})

    children  = build_tree(children_raw)
    ungrouped = build_tree([r for i, r in enumerate(routes) if i not in g_indices])

    parent: Route = {"receiver": parent_recv, "matchers": parent_matchers}
    if children:
        parent["routes"] = children

    return [parent] + ungrouped


# ── Public entry point ────────────────────────────────────────────────────────

def prune_routes(route_rules: List[Route],
                 top_matchers: List[Matcher] = None) -> List[Route]:
    stripped = strip_top(route_rules, top_matchers or [])
    return build_tree(stripped)


# ── Helpers ───────────────────────────────────────────────────────────────────

def count_nodes(routes: List[Route]) -> int:
    return sum(1 + count_nodes(r.get("routes", [])) for r in routes)


def clean_route(r: Route) -> Dict:
    out: Dict[str, Any] = {"receiver": r["receiver"]}
    ms = [{"key": m["key"], "op": m.get("op", "="), "value": m["value"]}
          for m in r.get("matchers", []) if m.get("key", "").strip()]
    if ms:
        out["matchers"] = ms
    if r.get("routes"):
        out["routes"] = [clean_route(c) for c in r["routes"]]
    return out


def load_input(src) -> Dict:
    content = src.read()
    try:
        return json.loads(content)
    except (json.JSONDecodeError, ValueError):
        return yaml.safe_load(content)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] != "-":
        with open(sys.argv[1]) as f:
            data = load_input(f)
    else:
        data = load_input(sys.stdin)

    rules   = data.get("routeRules",   [])
    top     = data.get("routeMatchers", [])
    pruned  = prune_routes(rules, top)

    output = {
        "routeRules": [clean_route(r) for r in pruned],
        "stats": {
            "before": len(rules),
            "after":  count_nodes(pruned),
        },
    }
    print(yaml.dump(output, default_flow_style=False, sort_keys=False), end="")


if __name__ == "__main__":
    main()
