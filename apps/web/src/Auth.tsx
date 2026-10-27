import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, ShieldCheck } from "lucide-react";
import { api } from "./api.ts";
import { setCsrfToken } from "./auth-client.ts";
type Identity = { id: number; username: string };
type SessionData = { user: Identity | null; csrfToken?: string };
type Props = {
  username: string;
  onLogout: () => Promise<void>;
  onPasswordChanged: (data: SessionData) => void;
};
export function AuthGate({
  children,
}: {
  children: (props: Props) => ReactNode;
}) {
  const [user, setUser] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(false),
    [error, setError] = useState("");
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState("");
  function accept(data: SessionData) {
    setCsrfToken(data.csrfToken || "");
    setUser(data.user);
  }
  useEffect(() => {
    let active = true;
    const expired = () => {
      setUser(null);
      setCsrfToken("");
      setError("会话已过期，请重新登录");
    };
    window.addEventListener("vocabflow-session-expired", expired);
    api("/auth/session")
      .then((data) => {
        if (active) accept(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.removeEventListener("vocabflow-session-expired", expired);
    };
  }, []);
  if (loading)
    return (
      <div className="loading">
        <BookOpen size={36} />
        <p>正在检查登录状态…</p>
      </div>
    );
  if (user)
    return children({
      username: user.username,
      onPasswordChanged: accept,
      onLogout: async () => {
        await api("/auth/logout", {});
        accept({ user: null });
      },
    });
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <BookOpen size={30} />
          <strong>VocabFlow AI</strong>
        </div>
        <p className="eyebrow">YOUR PRIVATE LEARNING SPACE</p>
        <h1>{register ? "创建你的学习账号" : "欢迎回来"}</h1>
        <p>
          {register
            ? "词库、学习进度与 AI 配置，按账号独立保存。"
            : "登录后，继续你的单词学习。"}
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            if (register && password !== confirm) {
              setError("两次密码不一致");
              return;
            }
            setBusy(true);
            try {
              const data = await api(
                register ? "/auth/register" : "/auth/login",
                { username, password },
              );
              setPassword("");
              setConfirm("");
              accept(data);
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            用户名
            <input
              required
              name="username"
              autoComplete="username"
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_]+"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3–32 位字母、数字或下划线"
            />
          </label>
          <label>
            密码
            <input
              required
              name="password"
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 12 个字符"
            />
          </label>
          {register && (
            <label>
              确认密码
              <input
                required
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          )}
          {error && (
            <p className="alert error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "请稍候…" : register ? "注册并开始学习" : "登录"}
          </button>
        </form>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            setRegister(!register);
            setError("");
            setPassword("");
            setConfirm("");
          }}
        >
          {register ? "已有账号？返回登录" : "还没有账号？立即注册"}
        </button>
        <p className="auth-note">
          <ShieldCheck size={16} />
          忘记密码请联系服务器管理员重置。
        </p>
      </section>
    </main>
  );
}
