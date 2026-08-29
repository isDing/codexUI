import { CircleAlert, FolderPlus, LoaderCircle, Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { IconButton } from "./components";
import { errorMessage } from "./lib";
import type { Workspace } from "./types";

export function WorkspaceDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (workspacePath: string) => Promise<void> }) {
  const [workspacePath, setWorkspacePath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onAdd(workspacePath.trim());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
      <header><div><FolderPlus size={18} /><h2 id="workspace-dialog-title">新增工作区</h2></div><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>
      <form onSubmit={add}>
        <div className="dialog-body">
          <label><span>工作区路径</span><input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/path/to/project" autoFocus /></label>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        </div>
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={submitting || !workspacePath.trim()}>{submitting ? <LoaderCircle className="spin" size={17} /> : <FolderPlus size={17} />}添加</button></footer>
      </form>
    </section>
  );
}

export function NewThreadDialog({ workspaces, initialWorkspace, onClose, onCreate }: {
  workspaces: Workspace[];
  initialWorkspace: string;
  onClose: () => void;
  onCreate: (cwd: string) => Promise<void>;
}) {
  const [cwd, setCwd] = useState(initialWorkspace || workspaces[0]?.path || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setSubmitting(true);
    setError("");
    try {
      await onCreate(cwd);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="new-thread-title">
      <header><div><Plus size={18} /><h2 id="new-thread-title">新建会话</h2></div><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="dialog-body">
        <label><span>工作区</span><select value={cwd} onChange={(event) => setCwd(event.target.value)}>{workspaces.map((workspace) => <option key={workspace.path} value={workspace.path}>{workspace.name} - {workspace.path}</option>)}</select></label>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      </div>
      <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => void create()} disabled={submitting || !cwd}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}创建</button></footer>
    </section>
  );
}
