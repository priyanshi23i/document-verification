
import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL = "http://localhost:5000/api/documents";
const MAX_SIZE_MB = 5;
const EXPIRY_WARNING_DAYS = 30;

const allowedTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
];

const allowedExtensions = ["pdf", "jpg", "jpeg", "png"];

function hasUploadedFile(doc) {
  // The backend must provide a filename and a stored file path.
  return Boolean(
    typeof doc.fileName === "string" &&
    doc.fileName.trim() &&
    typeof doc.filePath === "string" &&
    doc.filePath.trim()
  );
}

function getExpiryStatus(expiry) {
  if (!expiry) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expiryDate = new Date(`${expiry}T00:00:00`);

  if (Number.isNaN(expiryDate.getTime())) return null;

  const daysLeft = Math.round(
    (expiryDate.getTime() - today.getTime()) / 86400000
  );

  if (daysLeft < 0) {
    return {
      label: "Expired",
      message: `Expired ${Math.abs(daysLeft)} day(s) ago.`,
    };
  }

  if (daysLeft <= EXPIRY_WARNING_DAYS) {
    return {
      label: "Expiring Soon",
      message:
        daysLeft === 0
          ? "Expires today."
          : `Expires in ${daysLeft} day(s).`,
    };
  }

  return {
    label: "Valid",
    message: `Expires in ${daysLeft} day(s).`,
  };
}

function getAutomaticVerification(doc) {
  if (!doc.file) {
    return {
      status: "Missing",
      reason: "Required document has not been uploaded.",
    };
  }

  const extension = doc.file.split(".").pop().toLowerCase();

  if (!allowedExtensions.includes(extension)) {
    return {
      status: "Invalid",
      reason: "Unsupported file format. Upload a PDF, JPG or PNG.",
    };
  }

  const expiryStatus = getExpiryStatus(doc.expiry);

  if (expiryStatus?.label === "Expired") {
    return {
      status: "Expired",
      reason: `Certificate expired on ${doc.expiry}.`,
    };
  }

  if (expiryStatus?.label === "Expiring Soon") {
    return {
      status: "Pending",
      reason: `Certificate is expiring soon. ${expiryStatus.message}`,
    };
  }

  return {
    status: doc.status === "Verified" ? "Verified" : "Pending",
    reason:
      doc.status === "Verified"
        ? doc.reason || "Marked as verified by the reviewer."
        : "Document uploaded and awaiting reviewer verification.",
  };
}

function mapDocument(doc) {
  const uploaded = hasUploadedFile(doc);

  const mapped = {
    id: doc._id,
    name: doc.name,
    required: true,
    file: uploaded ? doc.fileName : "",
    expiry: doc.expiryDate
      ? String(doc.expiryDate).slice(0, 10)
      : "",
    status: doc.status || "Pending",
    reason: doc.reason || "",
  };

  // A missing filename or path always takes priority.
  if (!uploaded) {
    return {
      ...mapped,
      file: "",
      status: "Missing",
      reason: "Required document has not been uploaded.",
    };
  }

  return {
    ...mapped,
    ...getAutomaticVerification(mapped),
  };
}

function App() {
  const [documents, setDocuments] = useState([]);
  const [message, setMessage] = useState(
    "Loading documents from database..."
  );
  const [loading, setLoading] = useState(true);

  async function fetchDocuments() {
    setLoading(true);

    try {
      const response = await fetch(API_URL);

      if (!response.ok) {
        throw new Error("Could not load documents.");
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error("Unexpected response from the server.");
      }

      setDocuments(data.map(mapDocument));
      setMessage("");
    } catch (error) {
      console.error("Error loading documents:", error);
      setMessage(
        "Could not connect to the database. Please check that the backend is running."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchDocuments();
  }, []);

  const counts = useMemo(
    () => ({
      required: documents.filter((doc) => doc.required).length,
      uploaded: documents.filter((doc) => Boolean(doc.file)).length,
      verified: documents.filter(
        (doc) => doc.status === "Verified"
      ).length,
      missing: documents.filter(
        (doc) => doc.status === "Missing"
      ).length,
    }),
    [documents]
  );

  async function uploadDocument(id, file) {
    if (!file) return;

    if (!allowedTypes.includes(file.type)) {
      setMessage("Unsupported file type. Please upload PDF, JPG or PNG.");
      return;
    }

    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      setMessage("File exceeds the 5 MB size limit.");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_URL}/${id}/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not upload the file.");
      }

      if (!data.document) {
        throw new Error("The server did not return the uploaded document.");
      }

      const updatedDocument = mapDocument(data.document);

      if (!updatedDocument.file) {
        throw new Error(
          "Upload response does not contain a stored filename and file path."
        );
      }

      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === id ? updatedDocument : doc
        )
      );

      setMessage(`${file.name}: uploaded successfully.`);
    } catch (error) {
      console.error("Upload error:", error);
      setMessage(error.message || "Could not upload the file.");
      await fetchDocuments();
    }
  }

  async function reviewDocument(id, status) {
    try {
      const response = await fetch(`${API_URL}/${id}/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.message || "Could not update document status."
        );
      }

      if (data.document) {
        setDocuments((prev) =>
          prev.map((doc) =>
            doc.id === id ? mapDocument(data.document) : doc
          )
        );
      } else {
        await fetchDocuments();
      }

      setMessage(`Document status updated to ${status}.`);
    } catch (error) {
      console.error("Error updating document:", error);
      setMessage(error.message || "Could not update document status.");
    }
  }

  async function clearDocument(id) {
    try {
      const response = await fetch(`${API_URL}/${id}/remove-file`, {
        method: "PATCH",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to remove file.");
      }

      if (data.document) {
        setDocuments((prev) =>
          prev.map((doc) =>
            doc.id === id ? mapDocument(data.document) : doc
          )
        );
      } else {
        await fetchDocuments();
      }

      setMessage("File removed successfully. Document status is Missing.");
    } catch (error) {
      console.error("Error removing file:", error);
      setMessage(error.message || "Could not remove file.");
    }
  }

  async function saveExpiryDate(id, newExpiry) {
    try {
      const response = await fetch(`${API_URL}/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expiryDate: newExpiry || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not save expiry date.");
      }

      if (data.document) {
        setDocuments((prev) =>
          prev.map((doc) =>
            doc.id === id ? mapDocument(data.document) : doc
          )
        );
      } else {
        await fetchDocuments();
      }

      setMessage("Expiry date saved successfully.");
    } catch (error) {
      console.error("Error saving expiry date:", error);
      setMessage(error.message || "Could not save expiry date.");
    }
  }

  const issues = documents.filter((doc) => {
    const expiryStatus = getExpiryStatus(doc.expiry);

    return (
      doc.status === "Missing" ||
      doc.status === "Invalid" ||
      doc.status === "Expired" ||
      expiryStatus?.label === "Expired" ||
      expiryStatus?.label === "Expiring Soon"
    );
  });

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand-icon">✓</div>

        <div className="brand-text">
          <h1>Document Verification</h1>
          <p>Institution Approval Portal · Demo Prototype</p>
        </div>

        <span className="demo-badge">DEMO DATA</span>
      </header>

      <section className="application-card">
        <div>
          <p className="eyebrow">APPLICATION ID</p>
          <h2>DEMO-AICTE-001</h2>
          <p className="institution">Sunrise Institute of Technology</p>
          <p className="muted">
            Fictional institution · Sample application
          </p>
        </div>

        <div className="application-status">
          <span className="status-dot" />
          Under Review
        </div>
      </section>

      <section className="stats-grid">
        <Stat label="Required Documents" value={counts.required} />
        <Stat label="Uploaded" value={counts.uploaded} />
        <Stat label="Verified" value={counts.verified} />
        <Stat label="Missing" value={counts.missing} />
      </section>

      <section className="content-card">
        <div className="section-heading">
          <div>
            <h2>Required Document Checklist</h2>
            <p>Upload documents and review their validation status.</p>
          </div>

          <span className="count-badge">
            {documents.length} documents
          </span>
        </div>

        {message && (
          <div className="notice" role="status">
            {message}
          </div>
        )}

        {!loading && (
          <button
            type="button"
            className="text-button"
            onClick={fetchDocuments}
          >
            Refresh documents
          </button>
        )}

        {loading ? (
          <p>Loading documents...</p>
        ) : documents.length === 0 ? (
          <p className="empty-state">
            No checklist documents found. Add a document using your existing
            document-creation feature.
          </p>
        ) : (
          <div className="document-list">
            {documents.map((doc) => (
              <article className="document-row" key={doc.id}>
                <div className="file-icon">▤</div>

                <div className="document-info">
                  <h3>{doc.name}</h3>

                  <p className="file-name">
                    {doc.file
                      ? `Uploaded: ${doc.file}`
                      : "Document not uploaded"}
                  </p>

                  {doc.reason && (
                    <p
                      className={`reason ${
                        ["Invalid", "Missing", "Expired"].includes(doc.status)
                          ? "reason-error"
                          : ""
                      }`}
                    >
                      {doc.reason}
                    </p>
                  )}

                  <label className="expiry-input">
                    <span>Set expiry date</span>

                    <input
                      type="date"
                      value={doc.expiry}
                      onChange={(event) =>
                        saveExpiryDate(doc.id, event.target.value)
                      }
                    />
                  </label>

                  {doc.expiry && (
                    <div className="expiry-info">
                      <p className="file-name">
                        Expiry date: {doc.expiry}
                      </p>

                      {(() => {
                        const expiryStatus = getExpiryStatus(doc.expiry);

                        return (
                          expiryStatus && (
                            <p
                              className={`expiry-${expiryStatus.label
                                .toLowerCase()
                                .replace(" ", "-")}`}
                            >
                              {expiryStatus.label}: {expiryStatus.message}
                            </p>
                          )
                        );
                      })()}
                    </div>
                  )}
                </div>

                <div className="document-actions">
                  <span
                    className={`status status-${doc.status.toLowerCase()}`}
                  >
                    {doc.status}
                  </span>

                  <label className="upload-button">
                    {doc.file ? "Replace file" : "Upload file"}

                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png"
                      hidden
                      onChange={(event) => {
                        uploadDocument(doc.id, event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                  </label>

                  {doc.file && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        window.open(
                          `${API_URL}/${doc.id}/file`,
                          "_blank",
                          "noopener,noreferrer"
                        )
                      }
                    >
                      View File
                    </button>
                  )}

                  {doc.file && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => clearDocument(doc.id)}
                    >
                      Remove
                    </button>
                  )}

                  {doc.file && doc.status !== "Verified" && (
                    <button
                      type="button"
                      className="review-button"
                      onClick={() => reviewDocument(doc.id, "Verified")}
                    >
                      Mark Verified
                    </button>
                  )}

                  {doc.file && doc.status !== "Invalid" && (
                    <button
                      type="button"
                      className="reject-button"
                      onClick={() => reviewDocument(doc.id, "Invalid")}
                    >
                      Mark Invalid
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="content-card issues-card">
        <div className="section-heading">
          <div>
            <h2>Missing Documents &amp; Issues</h2>
            <p>Documents requiring attention from the reviewer.</p>
          </div>

          <span className="issue-count">{issues.length} issues</span>
        </div>

        {issues.length === 0 ? (
          <p className="empty-state">
            No missing, invalid, or expiry issues.
          </p>
        ) : (
          issues.map((doc) => {
            const expiryStatus = getExpiryStatus(doc.expiry);

            let issueMessage = doc.reason;

            if (expiryStatus?.label === "Expired") {
              issueMessage = `Certificate expired on ${doc.expiry}.`;
            } else if (expiryStatus?.label === "Expiring Soon") {
              issueMessage = `Certificate is expiring soon. ${expiryStatus.message}`;
            }

            return (
              <div className="issue-row" key={doc.id}>
                <span className="issue-symbol">!</span>

                <div>
                  <strong>{doc.name}</strong>
                  <p>{issueMessage || "This document requires attention."}</p>
                </div>

                <span
                  className={`status status-${doc.status.toLowerCase()}`}
                >
                  {doc.status}
                </span>

                {expiryStatus && (
                  <span
                    className={`expiry-${expiryStatus.label
                      .toLowerCase()
                      .replace(" ", "-")}`}
                  >
                    {expiryStatus.label}
                  </span>
                )}
              </div>
            );
          })
        )}
      </section>

      <footer>
        Prototype for demonstration only. File checks do not establish
        document authenticity. No live AICTE system is connected.
      </footer>
    </main>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat-card">
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
