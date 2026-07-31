import { useState } from "react";
import { uploadImage } from "../lib/api";

export function ImageUpload({ value, onChange, small }) {
  const [uploading, setUploading] = useState(false);
  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try { onChange(await uploadImage(file)); }
    catch (err) { alert(err.message || "Upload fehlgeschlagen."); }
    setUploading(false);
  }
  return (
    <div className="img-upload-area" style={{ position: "relative", ...(small ? { width: 80, padding: 8 } : {}) }}>
      <input type="file" accept="image/*" onChange={handleFile} />
      {value
        ? <img src={value} className="img-preview" style={small ? { width: 44, height: 44 } : {}} alt="" />
        : <div className="img-upload-label">{uploading ? "⏳" : "📷"}<br />{uploading ? "Lädt…" : small ? "Bild" : "Bild hochladen"}</div>}
      {value && !uploading && (
        <button type="button" title="Bild entfernen" aria-label="Bild entfernen"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(""); }}
          style={{ position: "absolute", top: 2, right: 2, width: 20, height: 20, lineHeight: "18px", textAlign: "center", padding: 0, border: "none", borderRadius: "50%", background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 12, cursor: "pointer" }}>✕</button>
      )}
    </div>
  );
}
