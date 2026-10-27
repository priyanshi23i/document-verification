
const express = require("express");
const router = express.Router();
const Document = require("../models/Document");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const uploadDir = path.join(__dirname, "..", "uploads");

const allowedExtensions = [".pdf", ".jpg", ".jpeg", ".png"];
const allowedMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
];

fs.mkdirSync(uploadDir, { recursive: true });

// -------------------- FILE UPLOAD SETUP --------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const safeName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (
      allowedMimeTypes.includes(file.mimetype) &&
      allowedExtensions.includes(extension)
    ) {
      return cb(null, true);
    }

    cb(new Error("Only PDF, JPG, JPEG, and PNG files are allowed."));
  },
});

// -------------------- FILE HELPERS --------------------

function getStoredPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return null;
  }

  // Only use the stored filename, never an arbitrary directory.
  const filename = path.basename(filePath);

  if (filename !== filePath || filename === "." || filename === "..") {
    return null;
  }

  return path.join(uploadDir, filename);
}

function fileExists(document) {
  if (
    !document ||
    typeof document.fileName !== "string" ||
    !document.fileName.trim() ||
    typeof document.filePath !== "string" ||
    !document.filePath.trim()
  ) {
    return false;
  }

  const storedPath = getStoredPath(document.filePath);

  return Boolean(
    storedPath &&
    fs.existsSync(storedPath) &&
    fs.statSync(storedPath).isFile()
  );
}

function isExpired(expiryDate) {
  if (!expiryDate) return false;

  const expiry = new Date(expiryDate);

  if (Number.isNaN(expiry.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiry.setHours(0, 0, 0, 0);

  return expiry < today;
}

// -------------------- AUTOMATIC STATUS CHECK --------------------

function checkDocumentStatus(document) {
  // No filename, no path, or no physical file means Missing.
  if (!fileExists(document)) {
    return {
      status: "Missing",
      reason: "No uploaded file was found on the server.",
      fileExists: false,
    };
  }

  const extension = path.extname(document.fileName).toLowerCase();

  if (!allowedExtensions.includes(extension)) {
    return {
      status: "Invalid",
      reason: "Unsupported file type. Upload a PDF, JPG, or PNG.",
      fileExists: true,
    };
  }

  if (document.expiryDate && isExpired(document.expiryDate)) {
    return {
      status: "Expired",
      reason: "The document's expiry date has passed.",
      fileExists: true,
    };
  }

  return {
    status: "Pending",
    reason: "File exists and passed basic checks. Awaiting review.",
    fileExists: true,
  };
}

// Update status while preserving reviewer decisions only when the file
// exists, is supported, and has not expired.
async function refreshDocumentStatus(document) {
  const result = checkDocumentStatus(document);

  if (["Missing", "Invalid", "Expired"].includes(result.status)) {
    document.status = result.status;
    document.reason = result.reason;
  } else if (
    document.status === "Verified" ||
    document.status === "Invalid"
  ) {
    // Preserve a valid reviewer decision.
    document.reason =
      document.status === "Verified"
        ? "Document approved by reviewer."
        : "Document marked invalid by reviewer.";
  } else {
    document.status = "Pending";
    document.reason = result.reason;
  }

  await document.save();
  return document;
}

// Return consistent file-existence information to the frontend.
function documentResponse(document) {
  const result = document.toObject();

  result.fileExists = fileExists(document);

  // Never return stale file details when the physical file is absent.
  if (!result.fileExists) {
    result.fileName = "";
    result.filePath = "";
    result.status = "Missing";
    result.reason = "No uploaded file was found on the server.";
  }

  return result;
}

// -------------------- GET ALL DOCUMENTS --------------------

router.get("/", async (req, res) => {
  try {
    const documents = await Document.find().sort({ createdAt: -1 });
    const results = [];

    for (const document of documents) {
      await refreshDocumentStatus(document);
      results.push(documentResponse(document));
    }

    res.json(results);
  } catch (error) {
    console.error("Fetch documents error:", error);

    res.status(500).json({
      message: "Failed to fetch documents.",
    });
  }
});

// -------------------- CREATE CHECKLIST ITEM --------------------

router.post("/", async (req, res) => {
  try {
    const { name, expiryDate } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        message: "A document name is required.",
      });
    }

    if (
      expiryDate &&
      Number.isNaN(Date.parse(expiryDate))
    ) {
      return res.status(400).json({
        message: "Invalid expiry date.",
      });
    }

    const document = await Document.create({
      name: name.trim(),
      fileName: "",
      filePath: "",
      expiryDate: expiryDate || null,
      status: "Missing",
      reason: "No document has been uploaded.",
    });

    return res.status(201).json({
      message: "Checklist item created. Upload a file to continue.",
      document: documentResponse(document),
    });
  } catch (error) {
    console.error("Create document error:", error);

    res.status(500).json({
      message: "Failed to create document.",
    });
  }
});

// -------------------- UPDATE REVIEW STATUS --------------------

router.patch("/:id/status", async (req, res) => {
  try {
    const allowedStatuses = [
      "Verified",
      "Pending",
      "Missing",
      "Invalid",
      "Expired",
    ];

    const requestedStatus = req.body.status;

    if (!allowedStatuses.includes(requestedStatus)) {
      return res.status(400).json({
        message: "Invalid document status.",
      });
    }

    const document = await Document.findById(req.params.id);

    if (!document) {
      return res.status(404).json({
        message: "Document not found.",
      });
    }

    const automatic = checkDocumentStatus(document);

    // Missing, unsupported, or expired files cannot be approved.
    if (
      ["Missing", "Invalid", "Expired"].includes(automatic.status) &&
      ["Verified", "Pending"].includes(requestedStatus)
    ) {
      document.status = automatic.status;
      document.reason = automatic.reason;
      await document.save();

      return res.status(400).json({
        message: `Cannot set status to ${requestedStatus}. ${automatic.reason}`,
        document: documentResponse(document),
      });
    }

    if (requestedStatus === "Missing" && automatic.fileExists) {
      return res.status(400).json({
        message: "Remove the uploaded file before marking it Missing.",
      });
    }

    if (requestedStatus === "Expired" && !document.expiryDate) {
      return res.status(400).json({
        message: "Set an expiry date before marking this document Expired.",
      });
    }

    document.status = requestedStatus;

    const reasons = {
      Verified: "Document approved by reviewer.",
      Pending: "Document is awaiting reviewer approval.",
      Missing: "No document has been uploaded.",
      Invalid: "Document marked invalid by reviewer.",
      Expired: "The document's expiry date has passed.",
    };

    document.reason = reasons[requestedStatus];

    await document.save();

    return res.json({
      message: "Document status updated.",
      document: documentResponse(document),
    });
  } catch (error) {
    console.error("Update status error:", error);

    res.status(error.name === "CastError" ? 400 : 500).json({
      message: "Failed to update document status.",
    });
  }
});

// -------------------- UPDATE EXPIRY DATE --------------------

router.patch("/:id", async (req, res) => {
  try {
    const { expiryDate } = req.body;

    if (
      expiryDate !== null &&
      expiryDate !== "" &&
      expiryDate !== undefined &&
      Number.isNaN(Date.parse(expiryDate))
    ) {
      return res.status(400).json({
        message: "Invalid expiry date.",
      });
    }

    const document = await Document.findById(req.params.id);

    if (!document) {
      return res.status(404).json({
        message: "Document not found.",
      });
    }

    document.expiryDate = expiryDate || null;

    const result = checkDocumentStatus(document);

    if (["Missing", "Invalid", "Expired"].includes(result.status)) {
      document.status = result.status;
      document.reason = result.reason;
    } else if (document.status !== "Verified") {
      document.status = "Pending";
      document.reason = result.reason;
    } else {
      document.reason = "Document approved by reviewer.";
    }

    await document.save();

    return res.json({
      message: "Expiry date updated.",
      document: documentResponse(document),
    });
  } catch (error) {
    console.error("Update expiry error:", error);

    res.status(error.name === "CastError" ? 400 : 500).json({
      message: "Failed to update expiry date.",
    });
  }
});

// -------------------- REMOVE FILE --------------------

router.patch("/:id/remove-file", async (req, res) => {
  try {
    const document = await Document.findById(req.params.id);

    if (!document) {
      return res.status(404).json({
        message: "Document not found.",
      });
    }

    const storedPath = getStoredPath(document.filePath);

    if (storedPath && fs.existsSync(storedPath)) {
      fs.unlinkSync(storedPath);
    }

    document.fileName = "";
    document.filePath = "";
    document.status = "Missing";
    document.reason = "No document has been uploaded.";

    await document.save();

    return res.json({
      message: "File removed successfully.",
      document: documentResponse(document),
    });
  } catch (error) {
    console.error("Remove file error:", error);

    res.status(error.name === "CastError" ? 400 : 500).json({
      message: "Failed to remove file.",
    });
  }
});

// -------------------- UPLOAD OR REPLACE FILE --------------------

router.post("/:id/upload", (req, res) => {
  upload.single("file")(req, res, async (error) => {
    if (error) {
      return res.status(400).json({
        message: error.message,
      });
    }

    if (!req.file) {
      return res.status(400).json({
        message: "Please select a file before uploading.",
      });
    }

    try {
      const document = await Document.findById(req.params.id);

      if (!document) {
        fs.unlinkSync(req.file.path);

        return res.status(404).json({
          message: "Document not found.",
        });
      }

      const oldPath = getStoredPath(document.filePath);

      document.fileName = req.file.originalname;
      document.filePath = req.file.filename;

      const result = checkDocumentStatus(document);
      document.status = result.status;
      document.reason = result.reason;

      await document.save();

      // Remove the old file only after the new file has been saved.
      if (
        oldPath &&
        oldPath !== req.file.path &&
        fs.existsSync(oldPath)
      ) {
        fs.unlinkSync(oldPath);
      }

      return res.json({
        message: "File uploaded successfully.",
        document: documentResponse(document),
      });
    } catch (saveError) {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      console.error("Upload error:", saveError);

      return res.status(500).json({
        message: "Could not save uploaded file.",
      });
    }
  });
});

// -------------------- VIEW FILE --------------------

router.get("/:id/file", async (req, res) => {
  try {
    const document = await Document.findById(req.params.id);

    if (!document) {
      return res.status(404).send("Document not found.");
    }

    if (!fileExists(document)) {
      document.fileName = "";
      document.filePath = "";
      document.status = "Missing";
      document.reason = "No uploaded file was found on the server.";

      await document.save();

      return res.status(404).send("No uploaded file was found.");
    }

    const storedPath = getStoredPath(document.filePath);
    return res.sendFile(storedPath);
  } catch (error) {
    console.error("View file error:", error);

    return res.status(error.name === "CastError" ? 400 : 500).send(
      "Could not open the document."
    );
  }
});

// -------------------- DELETE CHECKLIST ITEM --------------------

router.delete("/:id", async (req, res) => {
  try {
    const document = await Document.findById(req.params.id);

    if (!document) {
      return res.status(404).json({
        message: "Document not found.",
      });
    }

    const storedPath = getStoredPath(document.filePath);

    if (storedPath && fs.existsSync(storedPath)) {
      fs.unlinkSync(storedPath);
    }

    await document.deleteOne();

    return res.json({
      message: "Document record deleted.",
    });
  } catch (error) {
    console.error("Delete document error:", error);

    res.status(error.name === "CastError" ? 400 : 500).json({
      message: "Failed to delete document.",
    });
  }
});

module.exports = router;
