/** Small hook/slot harness: executes the shipped components and their real event handlers. */
export function renderer() {
  const instances = new Map();
  let current; let index; let root; let tree; let pending = false; let stopped = false;
  let effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const schedule = () => { if (!pending && !stopped) { pending = true; queueMicrotask(() => { pending = false; render(); }); } };
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat() } }; },
    useState(initial) {
      const instance = current, at = index++;
      if (!instance.hooks[at]) instance.hooks[at] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = instance.hooks[at];
      return [slot.value, (next) => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; schedule(); } }];
    },
    useRef(value) { const at = index++; return current.hooks[at] ??= { current: value }; },
    useMemo(fn, deps) { const at = index++; let slot = current.hooks[at]; if (!slot || !same(slot.deps, deps)) slot = current.hooks[at] = { deps, value: fn() }; return slot.value; },
    useEffect(fn, deps) {
      const at = index++; const instance = current; const old = instance.hooks[at];
      if (old && same(old.deps, deps)) return;
      const slot = instance.hooks[at] = { deps, cleanup: old?.cleanup };
      effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); });
    },
  };
  function visit(element, path, visited) {
    if (element == null || element === false) return null;
    if (typeof element !== 'object') return element;
    if (typeof element.type === 'function') {
      const key = path + '/' + element.type.name + ':' + (element.props.key ?? '');
      let instance = instances.get(key); if (!instance) { instance = { hooks: [] }; instances.set(key, instance); }
      visited.add(key); current = instance; index = 0;
      return visit(element.type(element.props), key, visited);
    }
    return { ...element, props: { ...element.props, children: (element.props.children ?? []).map((child, i) => visit(child, path + '/' + i, visited)).filter((child) => child !== null) } };
  }
  function render() {
    if (!root || stopped) return;
    effects = []; const visited = new Set(); tree = visit(root(), '', visited);
    for (const [key, instance] of instances) if (!visited.has(key)) { for (const slot of instance.hooks) slot?.cleanup?.(); instances.delete(key); }
    const run = effects; effects = []; for (const effect of run) effect();
  }
  function find(predicate, element = tree) {
    if (!element || typeof element !== 'object') return undefined;
    if (predicate(element)) return element;
    for (const child of element.props.children ?? []) { const hit = find(predicate, child); if (hit) return hit; }
  }
  return { React, mount(fn) { root = fn; render(); }, render, getTree: () => tree,
    byId: (id) => find((element) => element.props['data-testid'] === id),
    byLabel: (label) => find((element) => element.props['aria-label'] === label),
    text(element = tree) { if (!element || typeof element !== 'object') return String(element ?? ''); return (element.props.children ?? []).map((child) => this.text(child)).join(' '); },
    click(id) { const element = this.byId(id); if (!element || element.props.disabled) throw new Error('Button unavailable: ' + id); element.props.onClick(); },
    unmount() { stopped = true; for (const instance of instances.values()) for (const slot of instance.hooks) slot?.cleanup?.(); },
  };
}
