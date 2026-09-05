import { CircleAlert, Code2, LoaderCircle, LockKeyhole, User } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import webPackage from "../package.json";
import { CodexApiClient } from "./codex/api";
import { CodexDashboard } from "./codex/dashboard";
import { OpencodeApiClient } from "./opencode/api";
import { OpencodeDashboard } from "./opencode/dashboard";
import { LoadingScreen } from "./shared/components";
import { errorMessage, readSelection, writeSelection } from "./shared/lib";
import type { AuthState } from "./shared/types";

const APP_VERSION = webPackage.version;
const BACKEND_KEY = "codex-ui.backend";

export type BackendId = "codex" | "opencode";

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [backends, setBackends] = useState<BackendId[]>(["codex"]);
  const [backend, setBackend] = useState<BackendId>(() =>
    readSelection(BACKEND_KEY) === "opencode" ? "opencode" : "codex",
  );

  const onUnauthorized = useCallback(() => setAuth({ authenticated: false }), []);
  const codexApi = useMemo(() => new CodexApiClient(onUnauthorized), [onUnauthorized]);
  const opencodeApi = useMemo(() => new OpencodeApiClient(onUnauthorized), [onUnauthorized]);

  const handleAuthChange = useCallback(
    (next: AuthState) => {
      codexApi.setCsrfToken(next.csrfToken);
      opencodeApi.setCsrfToken(next.csrfToken);
      setAuth(next);
    },
    [codexApi, opencodeApi],
  );

  useEffect(() => {
    void codexApi
      .authSession()
      .then((session) => {
        codexApi.setCsrfToken(session.csrfToken);
        opencodeApi.setCsrfToken(session.csrfToken);
        setAuth(session);
      })
      .catch(() => setAuth({ authenticated: false }));
  }, [codexApi, opencodeApi]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    void codexApi
      .meta()
      .then((value) => setBackends(value.backends.filter((entry): entry is BackendId => entry === "codex" || entry === "opencode")))
      .catch(() => undefined);
  }, [auth?.authenticated, codexApi]);

  const switchBackend = (next: BackendId) => {
    setBackend(next);
    writeSelection(BACKEND_KEY, next === "codex" ? null : next);
  };

  if (!auth) return <LoadingScreen />;
  if (!auth.authenticated) {
    return (
      <LoginScreen
        onLogin={async (username, password) => {
          const session = await codexApi.login(username, password);
          codexApi.setCsrfToken(session.csrfToken);
          opencodeApi.setCsrfToken(session.csrfToken);
          setAuth(session);
        }}
      />
    );
  }

  const activeBackend: BackendId = backend === "opencode" && backends.includes("opencode") ? "opencode" : "codex";
  const switcher = backends.length > 1 ? (
    <div className="backend-switch" role="tablist" aria-label="切换后端">
      <button
        type="button"
        role="tab"
        aria-selected={activeBackend === "codex"}
        className={activeBackend === "codex" ? "active" : ""}
        onClick={() => switchBackend("codex")}
      >
        Codex
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeBackend === "opencode"}
        className={activeBackend === "opencode" ? "active" : ""}
        onClick={() => switchBackend("opencode")}
      >
        OpenCode
      </button>
    </div>
  ) : null;

  if (activeBackend === "opencode") {
    return (
      <OpencodeDashboard
        key="opencode"
        api={opencodeApi}
        auth={auth}
        onAuthChange={handleAuthChange}
        switcher={switcher}
      />
    );
  }
  return (
    <CodexDashboard
      key="codex"
      api={codexApi}
      auth={auth}
      onAuthChange={handleAuthChange}
      switcher={switcher}
    />
  );
}

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await onLogin(username, password);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-shell" aria-labelledby="login-title">
        <header className="login-brand">
          <div className="brand-mark"><Code2 size={23} /></div>
          <div>
            <div className="login-title-row"><h1 id="login-title">Codex UI</h1><span className="app-version">v{APP_VERSION}</span></div>
            <p>服务器会话控制台</p>
          </div>
        </header>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>用户名</span>
            <div className="input-with-icon">
              <User size={17} />
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
            </div>
          </label>
          <label>
            <span>密码</span>
            <div className="input-with-icon">
              <LockKeyhole size={17} />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>
          </label>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          <button className="primary-button login-button" type="submit" disabled={submitting || !username || !password}>
            {submitting ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={17} />}
            登录
          </button>
        </form>
      </section>
    </main>
  );
}
