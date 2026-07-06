export default function NotFound() {
  return (
    <div
      style={{
        maxWidth: "36rem",
        margin: "0 auto",
        padding: "96px 24px",
        textAlign: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>Page not found</h1>
      <p style={{ color: "#767c84" }}>
        That page is not in this docs site. <a href="/">Back to the docs</a>.
      </p>
    </div>
  );
}
