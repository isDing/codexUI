import { Archive, Code2, LoaderCircle, MessageSquare, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { relativeTime, sourceLabel, threadTitle } from "./lib";
import type { Thread } from "./types";

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

export function SidebarHeading({ icon, title, onClose }: { icon: ReactNode; title: string; onClose: () => void }) {
  return (
    <header className="sidebar-heading">
      <span>{icon}<strong>{title}</strong></span>
      <button className="drawer-close" onClick={onClose} title="关闭"><X size={18} /></button>
    </header>
  );
}

export function ThreadRow({ thread, selected, unread, onSelect }: {
  thread: Thread;
  selected: boolean;
  unread: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`thread-row ${selected ? "selected" : ""} ${unread ? "unread" : ""}`} onClick={onSelect}>
      <span className="thread-title-line">
        <strong>{threadTitle(thread)}</strong>
        {thread.status.type === "active" && <LoaderCircle className="spin active-icon" size={15} />}
        {thread.archived && <Archive size={14} />}
        {unread && <span className="unread-dot" title="任务已完成" />}
      </span>
      <span className="thread-meta">
        <span>{sourceLabel(thread.source)}</span>
        <time>{relativeTime((thread.recencyAt ?? thread.updatedAt) * 1000)}</time>
      </span>
    </button>
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
