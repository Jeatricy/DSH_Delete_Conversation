// The build wraps this factory in DSH's browser module loader. React is supplied by DSH.
export function createClientPlugin(React, dictionaries) {
  const h = React.createElement;
  const namespace = 'delete-conversation';
  const styles = `
.dsh-delete-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-delete-button:hover,.dsh-delete-menu:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-delete-button:focus-visible,.dsh-delete-menu:focus-visible,.dsh-delete-dialog button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dsh-delete-menu{display:flex;align-items:center;gap:8px;width:100%;border:0;border-radius:6px;padding:6px 8px;background:transparent;color:var(--dsw-alias-state-error-primary);text-align:left;font:inherit;font-size:13px;cursor:pointer}
.dsh-delete-dialog{box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;overflow:auto}
.dsh-delete-dialog::backdrop{background:var(--dsw-alias-bg-overlay)}
.dsh-delete-dialog h2{font-size:18px;line-height:26px;font-weight:600;margin:0 0 14px}
.dsh-delete-dialog p{font-size:14px;line-height:22px;margin:12px 0;color:var(--dsw-alias-label-secondary)}
.dsh-delete-title{display:block;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow-wrap:anywhere;font-size:14px;line-height:22px;font-weight:500}
.dsh-delete-dialog p.dsh-delete-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-delete-dialog .dsh-delete-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-delete-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
.dsh-delete-footer button{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 14px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
.dsh-delete-footer button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-delete-footer button.dsh-delete-confirm{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-delete-footer button:disabled{opacity:.5;cursor:wait}
`;

  function TrashIcon() {
    return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7' }));
  }

  return {
    inject: ['slots', 'connection', 'locale'],
    apply(ctx) {
      let current = null;
      let disposed = false;
      const listeners = new Set();
      const snapshot = () => current;
      const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
      const publish = (next) => {
        if (disposed) return;
        current = next;
        for (const listener of listeners) listener();
      };
      const request = (sessionId, displayTitle) => {
        if (current?.pending) return;
        publish({ sessionId, displayTitle, pending: false, error: null });
      };
      const close = () => { if (!current?.pending) publish(null); };
      const confirm = async () => {
        if (!current || current.pending) return;
        const target = current;
        publish({ ...target, pending: true, error: null });
        try {
          const result = await ctx.connection.rpc.call('/api', 'dsh-delete-conversation/delete', {
            sessionId: target.sessionId,
            confirm: true,
          });
          if (!result?.ok) throw new Error(result?.error?.message || 'Invalid deletion response');
          const warnings = result.value?.warnings ?? [];
          publish(warnings.length ? { ...target, pending: false, completed: true, warnings, error: null } : null);
          // A fresh generation obtains the authoritative catalog after physical deletion.
          ctx.connection.reconnect();
        } catch (error) {
          publish({ ...target, pending: false, error: error instanceof Error ? error.message : String(error) });
        }
      };

      function DeleteButton({ sessionId, displayTitle, t }) {
        return h('button', {
          type: 'button', className: 'dsh-delete-button',
          'aria-label': t('delete'), title: t('delete'), 'data-dsh-delete-session': sessionId,
          onClick: (event) => { event.stopPropagation(); request(sessionId, displayTitle); },
        }, h(TrashIcon));
      }
      function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
        const [, setOpen] = useMenuOpenState();
        return h('button', {
          type: 'button', role: 'menuitem', className: 'dsh-delete-menu',
          onClick: () => { setOpen(false); request(sessionId, displayTitle); },
        }, h(TrashIcon), t('delete'));
      }
      function Confirmation({ state, t }) {
        const dialog = React.useRef(null);
        const cancel = React.useRef(null);
        React.useEffect(() => {
          const previousFocus = document.activeElement;
          dialog.current.showModal();
          cancel.current?.focus();
          return () => {
            dialog.current?.close();
            if (previousFocus?.isConnected) previousFocus.focus();
          };
        }, []);
        return h('dialog', {
          ref: dialog, className: 'dsh-delete-dialog',
          'aria-labelledby': 'dsh-delete-heading', 'aria-describedby': 'dsh-delete-description',
          'aria-busy': state.pending,
          onCancel: (event) => { event.preventDefault(); close(); },
        },
        h('h2', { id: 'dsh-delete-heading' }, t(state.completed ? 'completedTitle' : 'confirmTitle')),
        h('strong', { className: 'dsh-delete-title' }, state.displayTitle || t('untitled')),
        h('p', { id: 'dsh-delete-description' }, t(state.completed ? 'cleanupWarning' : 'description')),
        !state.completed && h('p', { className: 'dsh-delete-note' }, t('filesNote')),
        state.completed && h('p', { className: 'dsh-delete-note', role: 'status' }, state.warnings.map(item => item.message).join(' ')),
        state.pending && h('p', { role: 'status', 'aria-live': 'polite' }, t('pending')),
        state.error && h('p', { className: 'dsh-delete-error', role: 'alert' }, `${t('failed')}: ${state.error}`),
        h('div', { className: 'dsh-delete-footer' },
          h('button', { ref: cancel, type: 'button', disabled: state.pending, onClick: close }, t(state.completed ? 'done' : 'cancel')),
          !state.completed && h('button', { type: 'button', className: 'dsh-delete-confirm', disabled: state.pending, onClick: confirm }, t(state.error ? 'retry' : 'confirm'))));
      }
      function Overlay({ t }) {
        const state = React.useSyncExternalStore(subscribe, snapshot, snapshot);
        return h(React.Fragment, null,
          h('style', { 'data-dsh-delete-styles': '' }, styles),
          state && h(Confirmation, { key: state.sessionId, state, t }));
      }
      ctx.effect(() => ctx.locale.register(namespace, dictionaries), 'delete-conversation: locale');
      ctx.effect(() => () => { disposed = true; listeners.clear(); current = null; }, 'delete-conversation: state');
      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action', id: 'delete-conversation', order: 150, locale: namespace,
      }, DeleteButton));
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: 'delete-conversation', order: 410, locale: namespace,
      }, DeleteMenuItem));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'delete-conversation.confirm', locale: namespace,
      }, Overlay));
    },
  };
}
