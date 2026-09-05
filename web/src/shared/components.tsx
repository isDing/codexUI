import { Archive, Code2, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";

export function LoadingScreen() {
  return (
    <main className="loading-screen" aria-label="正在载入">
      <div className="brand-mark"><Code2 size={22} /></div>
      <LoaderCircle className="spin" size={20} />
    </main>
  );
}

export function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return <button className="icon-button" title={title} aria-label={title} onClick={onClick}>{children}</button>;
}

export function SidebarHeading({ icon, title, onClose, collapsed = false, onToggle }: {
  icon: ReactNode;
  title: string;
  onClose: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <header className={`sidebar-heading ${collapsed ? "collapsed" : ""}`}>
      <span className="sidebar-heading-title">{icon}<strong>{title}</strong></span>
      {onToggle && (
        <button
          type="button"
          className="sidebar-toggle"
          title={collapsed ? "展开左侧边栏" : "收起左侧边栏"}
          aria-label={collapsed ? "展开左侧边栏" : "收起左侧边栏"}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      )}
      <button className="drawer-close" onClick={onClose} title="关闭"><X size={18} /></button>
    </header>
  );
}

export function ThreadRow({ title, meta, time, active = false, archived = false, unread = false, selected, onSelect, onDelete, deleting = false }: {
  title: string;
  meta: string;
  time: string;
  active?: boolean;
  archived?: boolean;
  unread?: boolean;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleting?: boolean;
}) {
  return (
    <div className={`thread-row ${selected ? "selected" : ""} ${unread ? "unread" : ""}`}>
      <button className="thread-row-main" onClick={onSelect} aria-pressed={selected}>
        <span className="thread-title-line">
          <strong>{title}</strong>
          {active && <LoaderCircle className="spin active-icon" size={15} />}
          {archived && <Archive size={14} />}
          {unread && <span className="unread-dot" title="任务已完成" />}
        </span>
        <span className="thread-meta">
          <span>{meta}</span>
          <time>{time}</time>
        </span>
      </button>
      <button
        className="thread-row-delete"
        title="删除会话"
        aria-label={`删除会话 ${title}`}
        disabled={deleting}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        {deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
      </button>
    </div>
  );
}

export function EmptyConversation({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  return (
    <div className="empty-conversation">
      <div className="empty-icon"><MessageSquare size={24} /></div>
      <h2>选择一个会话</h2>
      <p>历史记录与正在进行的任务会显示在这里。</p>
      <button className="primary-button" onClick={onCreate} disabled={disabled}><Plus size={17} />新建会话</button>
    </div>
  );
}
