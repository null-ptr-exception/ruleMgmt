import React, { useState } from 'react';
import { buildTree } from '../utils/treeGrouping';

function countLeaves(node) {
  if (!node.children || node.children.length === 0) return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

function TreeNode({ node, activeTemplate, onSelect }) {
  const [expanded, setExpanded] = useState(true);

  if (node.children && node.children.length > 0) {
    return (
      <div className="tree-v2-group">
        <div className="tree-v2-group-label" onClick={() => setExpanded(!expanded)}>
          <span className={`tree-v2-arrow ${expanded ? 'open' : ''}`}>&#9654;</span>
          <span>{node.label}</span>
          <span className="tree-v2-count">{countLeaves(node)}</span>
        </div>
        {expanded && (
          <div>
            {node.children.map((child) => (
              <TreeNode
                key={child.fullName || child.label}
                node={child}
                activeTemplate={activeTemplate}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`tree-v2-item ${node.fullName === activeTemplate ? 'active' : ''}`}
      onClick={() => onSelect(node.fullName)}
    >
      {node.label}
    </div>
  );
}

export default function TemplateTree({ templates, activeTemplate, onSelect }) {
  const names = (templates || []).map((t) => (typeof t === 'string' ? t : t.name));
  const tree = buildTree(names);

  return (
    <div className="tree-v2">
      {tree.map((node) => (
        <TreeNode
          key={node.fullName || node.label}
          node={node}
          activeTemplate={activeTemplate}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
