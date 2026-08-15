import { CircleAlert, FolderPlus, LoaderCircle, Plus, ShieldAlert, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { IconButton } from "./components";
import { effortLabel, errorMessage, modelFor } from "./lib";
import type { Model, Preferences, Workspace } from "./types";

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

export function NewThreadDialog({ workspaces, initialWorkspace, models, onClose, onCreate }: {
  workspaces: Workspace[];
  initialWorkspace: string;
  models: Model[];
  onClose: () => void;
  onCreate: (cwd: string, value: Preferences) => Promise<void>;
}) {
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const [cwd, setCwd] = useState(initialWorkspace || workspaces[0]?.path || "");
  const [model, setModel] = useState(defaultModel?.model ?? "");
  const [effort, setEffort] = useState(defaultModel?.defaultReasoningEffort ?? "medium");
  const [fullAccess, setFullAccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const selectedModel = modelFor(models, model);

  const create = async () => {
    setSubmitting(true);
    setError("");
    try {
      await onCreate(cwd, { model, effort, fullAccess });
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
        <div className="dialog-grid">
          <label><span>模型</span><select value={model} onChange={(event) => { const next = modelFor(models, event.target.value); setModel(event.target.value); setEffort(next?.defaultReasoningEffort ?? "medium"); }}>{models.map((entry) => <option key={entry.id} value={entry.model} title={entry.description}>{entry.displayName}</option>)}</select></label>
          <label><span>思考强度</span><select value={effort} onChange={(event) => setEffort(event.target.value)}>{selectedModel?.supportedReasoningEfforts.map((entry) => <option key={entry.reasoningEffort} value={entry.reasoningEffort} title={entry.description}>{effortLabel(entry.reasoningEffort)}</option>)}</select></label>
        </div>
        <label className="dialog-toggle"><div><ShieldAlert size={17} /><span><strong>完全访问权限</strong><small>关闭沙箱与命令审批</small></span></div><input type="checkbox" checked={fullAccess} onChange={(event) => setFullAccess(event.target.checked)} /><i /></label>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      </div>
      <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => void create()} disabled={submitting || !cwd || !model}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}创建</button></footer>
    </section>
  );
}
