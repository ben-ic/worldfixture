import { useState } from "react";
import { copy } from "../api.js";

export function Button({ children, kind = "", className = "", ...props }) {
  return <button className={`button ${kind} ${className}`.trim()} {...props}>{children}</button>;
}

export function CopyButton({ value, children = "Copy", kind = "small" }) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    await copy(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return <Button kind={kind} onClick={onClick}>{copied ? "Copied" : children}</Button>;
}

export function Panel({ title, tools, children, className = "" }) {
  return <section className={`panel ${className}`.trim()}>
    {(title || tools) && <header className="panel-head"><strong>{title}</strong><span>{tools}</span></header>}
    {children}
  </section>;
}

export function PageHead({ title, subtitle, command }) {
  return <header className="page-head"><div><h1>{title}</h1><p>{subtitle}</p></div><code>{command}</code></header>;
}

export function SectionTitle({ number, title, detail }) {
  return <div className="section-title"><span>{number}</span><h2>{title}</h2>{detail && <p>{detail}</p>}</div>;
}

export function Avatar({ name }) {
  const text = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <span className="avatar">{text}</span>;
}

export function Notice({ kind = "", children }) {
  return <div className={`notice ${kind}`.trim()}>{children}</div>;
}
