import * as vscode from "vscode";
import * as path from "path";
import { S3Explorer } from "./tree/explorer";
import { S3FileSystemProvider } from "./fs/provider";
import { listBuckets, searchObjects } from "./s3/listing";
import {
  createFolder,
  uploadFile,
  downloadFile,
  deleteObject,
  deleteObjects,
  copyObject,
  moveObject,
  generatePresignedUrl,
  generatePublicUrl,
  getObjectMetadata,
} from "./s3/ops";
import { testConnection, clearClientCache, getConfig } from "./s3/client";
import { s3Cache } from "./util/cache";
import {
  LoadMoreNode,
  isObjectNode,
  isLoadMoreNode,
  isPrefixNode,
  isBucketNode,
} from "./tree/nodes";
import {
  withUploadProgress,
  withDownloadProgress,
  withDeleteProgress,
  withCopyProgress,
  withMoveProgress,
  withProgress,
} from "./ui/progress";
import {
  promptForBucket,
  promptForFolderName,
  promptForSearchTerm,
  promptForPresignedUrlExpiry,
  promptForDestructiveConfirmation,
  promptForMoveOrCopy,
  promptForConfigurationSetup,
  showFilePicker,
  showFolderPicker,
  showSaveDialog,
  showErrorMessage,
  showInformationMessage,
} from "./ui/prompts";
import {
  joinPath,
  getFileName,
  isImageFile,
  isVideoFile,
  isAudioFile,
  applyFileNameTemplate,
} from "./util/paths";

let s3Explorer: S3Explorer;
let s3FileSystemProvider: S3FileSystemProvider;
let s3TreeView: vscode.TreeView<any>;

export async function activate(context: vscode.ExtensionContext) {
  console.log("S3/R2 Explorer is activating...");

  // Initialize providers
  s3Explorer = new S3Explorer();
  s3FileSystemProvider = new S3FileSystemProvider();

  // Register FileSystem provider for s3x:// scheme
  const fsProviderDisposable = vscode.workspace.registerFileSystemProvider(
    "s3x",
    s3FileSystemProvider
  );
  context.subscriptions.push(fsProviderDisposable);

  // Register TreeDataProvider
  s3TreeView = vscode.window.createTreeView("s3xExplorer", {
    treeDataProvider: s3Explorer,
    dragAndDropController: s3Explorer,
    canSelectMany: true,
  });
  context.subscriptions.push(s3TreeView);

  // Register commands
  registerCommands(context);

  // Check initial configuration
  const isConfigured = await promptForConfigurationSetup();
  if (isConfigured) {
    // Test connection on startup
    try {
      await testConnection();
      showInformationMessage("Connected to S3/R2 successfully!");
    } catch (error) {
      showErrorMessage(
        `Failed to connect to S3/R2: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }

  console.log("S3/R2 Explorer activated successfully");
}

export function deactivate() {
  clearClientCache();
  s3Cache.invalidateAll();
}

function registerCommands(context: vscode.ExtensionContext) {
  // Core commands
  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.refresh", async (node) => {
      try {
        s3Explorer.refresh(node);
      } catch (error) {
        console.error("Error during refresh:", error);
        // If refresh fails, try a full refresh
        s3Cache.invalidateAll();
        s3Explorer.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.configure", async () => {
      // Open VS Code settings page to S3X section
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "s3x"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "s3x.loadMore",
      async (node: LoadMoreNode) => {
        if (isLoadMoreNode(node)) {
          await s3Explorer.loadMore(node);
        }
      }
    )
  );

  // CRUD commands
  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.createFolder", async (node) => {
      await handleCreateFolder(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.uploadFile", async (node) => {
      await handleUploadFile(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.pasteUpload", async (node) => {
      await handlePasteUpload(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.uploadFolder", async (node) => {
      await handleUploadFolder(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.download", async (node) => {
      await handleDownload(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.rename", async (node) => {
      await handleRename(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.delete", async (node) => {
      await handleDelete(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.copy", async (node) => {
      await handleCopy(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.move", async (node) => {
      await handleMove(node);
    })
  );

  // Utility commands
  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.presign", async (node) => {
      await handleGeneratePresignedUrl(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.publicUrl", async (node) => {
      await handleGeneratePublicUrl(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.search", async () => {
      await handleSearch();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.showMetadata", async (node) => {
      await handleShowMetadata(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.previewMedia", async (node) => {
      // Handle both direct calls with parameters and context menu calls with nodes
      if (node && isObjectNode(node)) {
        await handlePreviewMedia({
          bucket: node.bucket,
          key: node.key,
          uri: node.resourceUri,
        });
      } else {
        await handlePreviewMedia(node);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.openFile", async (node) => {
      await handleOpenFile(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.reauth", async () => {
      clearClientCache();
      await promptForConfigurationSetup();
      s3Explorer.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.configureWizard", async () => {
      await promptForConfigurationSetup();
      s3Explorer.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.smokeTest", async () => {
      await handleSmokeTest();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.refreshAll", async () => {
      // Force complete refresh - clear all caches and reload from scratch
      console.log("Force refreshing all S3 data...");
      s3Cache.invalidateAll();
      clearClientCache();
      s3Explorer.refresh();
      showInformationMessage("S3/R2 Explorer refreshed completely");
    })
  );
}

// Command handlers
async function handleCreateFolder(node: any) {
  try {
    let bucket: string;
    let prefix = "";

    if (isBucketNode(node)) {
      bucket = node.bucket;
    } else if (isPrefixNode(node)) {
      bucket = node.bucket;
      prefix = node.prefix;
    } else {
      const selectedBucket = await promptForBucket();
      if (!selectedBucket) {
        return;
      }
      bucket = selectedBucket;
    }

    const folderName = await promptForFolderName();
    if (!folderName) {
      return;
    }

    const folderKey = joinPath(prefix, folderName);

    await withProgress(
      {
        title: `Creating folder "${folderName}"`,
        location: vscode.ProgressLocation.Notification,
      },
      async (progress) => {
        progress.report({ message: "Creating folder..." });
        await createFolder(bucket, folderKey);
      }
    );

    // Invalidate cache and refresh
    s3Cache.invalidate(bucket, prefix);
    s3Explorer.refresh(node);

    showInformationMessage(`Folder "${folderName}" created successfully`);
  } catch (error) {
    showErrorMessage(
      `Failed to create folder: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

async function handleUploadFile(node: any) {
  try {
    let bucket: string;
    let prefix = "";

    if (isBucketNode(node)) {
      bucket = node.bucket;
    } else if (isPrefixNode(node)) {
      bucket = node.bucket;
      prefix = node.prefix;
    } else {
      const selectedBucket = await promptForBucket();
      if (!selectedBucket) {
        return;
      }
      bucket = selectedBucket;
    }

    const files = await showFilePicker({
      title: "Select files to upload",
    });

    if (!files || files.length === 0) {
      return;
    }

    for (const file of files) {
      const originalFileName = path.basename(file.fsPath);
      const config = getConfig();
      const fileName = applyFileNameTemplate(originalFileName, config.uploadFileNameTemplate);
      const objectKey = joinPath(prefix, fileName);

      await withUploadProgress(async (progress) => {
        progress.report({ message: `Uploading ${fileName}...` });
        await uploadFile(bucket, objectKey, file.fsPath, (progressPercent) => {
          progress.setProgress(
            progressPercent,
            `Uploading ${fileName}... ${progressPercent}%`
          );
        });
      }, fileName);
    }

    // Invalidate cache and refresh
    s3Cache.invalidate(bucket, prefix);
    s3Explorer.refresh(node);

    showInformationMessage(
      `Uploaded ${files.length} file${files.length > 1 ? "s" : ""} successfully`
    );
  } catch (error) {
    showErrorMessage(
      `Failed to upload files: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

async function handlePasteUpload(node: any) {
  try {
    // If no node provided, get from tree view selection
    if (!node && s3TreeView.selection.length > 0) {
      node = s3TreeView.selection[0];
    }

    let bucket: string;
    let prefix = "";

    if (isBucketNode(node)) {
      bucket = node.bucket;
    } else if (isPrefixNode(node)) {
      bucket = node.bucket;
      prefix = node.prefix;
    } else {
      const selectedBucket = await promptForBucket();
      if (!selectedBucket) {
        return;
      }
      bucket = selectedBucket;
    }

    const fs = await import("fs");
    const os = await import("os");
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    // Try to get image from clipboard
    const tempImagePath = path.join(os.tmpdir(), `s3x-paste-${Date.now()}.png`);
    let hasImage = false;

    try {
      if (process.platform === "darwin") {
        // macOS: use osascript to get clipboard image
        await execAsync(`osascript -e 'set theImage to the clipboard as «class PNGf»' -e 'set theFile to open for access POSIX file "${tempImagePath}" with write permission' -e 'write theImage to theFile' -e 'close access theFile'`);
        hasImage = fs.existsSync(tempImagePath) && (await fs.promises.stat(tempImagePath)).size > 0;
      } else if (process.platform === "win32") {
        // Windows: use PowerShell to get clipboard image
        await execAsync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${tempImagePath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png) }"`);
        hasImage = fs.existsSync(tempImagePath) && (await fs.promises.stat(tempImagePath)).size > 0;
      }
    } catch (err) {
      // Ignore errors, fall back to text handling
    }

    if (hasImage) {
      try {
        const config = getConfig();
        const template = config.pasteImageFileNameTemplate || "image-${dateTime}.png";

        const now = new Date();
        const date = now.toISOString().split('T')[0];
        const dateTime = now.toISOString().replace(/[:.]/g, '-').split('.')[0].replace('T', '-');
        const timestamp = Date.now().toString();

        const fileName = template
          .replace(/\$\{date\}/g, date)
          .replace(/\$\{dateTime\}/g, dateTime)
          .replace(/\$\{timestamp\}/g, timestamp);

        const objectKey = joinPath(prefix, fileName);

        await withUploadProgress(async (progress) => {
          progress.report({ message: `Uploading ${fileName}...` });
          await uploadFile(bucket, objectKey, tempImagePath, (progressPercent) => {
            progress.setProgress(progressPercent, `Uploading ${fileName}... ${progressPercent}%`);
          });
        }, fileName);

        s3Cache.invalidate(bucket, prefix);
        s3Explorer.refresh(node);
        showInformationMessage(`Uploaded "${fileName}" from clipboard successfully`);
      } finally {
        await fs.promises.unlink(tempImagePath).catch(() => {});
      }
      return;
    }

    // No image, try text
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText) {
      showErrorMessage("Clipboard is empty");
      return;
    }

    // Check if clipboard contains a file path
    if (fs.existsSync(clipboardText.trim())) {
      const filePath = clipboardText.trim();
      const stat = await fs.promises.stat(filePath);

      if (stat.isFile()) {
        const originalFileName = path.basename(filePath);
        const config = getConfig();
        const fileName = applyFileNameTemplate(originalFileName, config.uploadFileNameTemplate);
        const objectKey = joinPath(prefix, fileName);

        await withUploadProgress(async (progress) => {
          progress.report({ message: `Uploading ${fileName}...` });
          await uploadFile(bucket, objectKey, filePath, (progressPercent) => {
            progress.setProgress(progressPercent, `Uploading ${fileName}... ${progressPercent}%`);
          });
        }, fileName);

        s3Cache.invalidate(bucket, prefix);
        s3Explorer.refresh(node);
        showInformationMessage(`Uploaded "${fileName}" from clipboard successfully`);
        return;
      }
    }

    // Clipboard contains text content - create temporary file
    const fileName = await vscode.window.showInputBox({
      prompt: "Enter filename for clipboard content",
      value: `clipboard-${Date.now()}.txt`,
    });

    if (!fileName) {
      return;
    }

    const tempFilePath = path.join(os.tmpdir(), `s3x-paste-${Date.now()}.tmp`);
    await fs.promises.writeFile(tempFilePath, clipboardText, "utf-8");

    try {
      const config = getConfig();
      const finalFileName = applyFileNameTemplate(fileName, config.uploadFileNameTemplate);
      const objectKey = joinPath(prefix, finalFileName);

      await withUploadProgress(async (progress) => {
        progress.report({ message: `Uploading ${finalFileName}...` });
        await uploadFile(bucket, objectKey, tempFilePath, (progressPercent) => {
          progress.setProgress(progressPercent, `Uploading ${finalFileName}... ${progressPercent}%`);
        });
      }, finalFileName);

      s3Cache.invalidate(bucket, prefix);
      s3Explorer.refresh(node);
      showInformationMessage(`Uploaded "${finalFileName}" from clipboard successfully`);
    } finally {
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }
  } catch (error) {
    showErrorMessage(
      `Failed to paste upload: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleUploadFolder(node: any) {
  try {
    let bucket: string;
    let prefix = "";

    if (isBucketNode(node)) {
      bucket = node.bucket;
    } else if (isPrefixNode(node)) {
      bucket = node.bucket;
      prefix = node.prefix;
    } else {
      const selectedBucket = await promptForBucket();
      if (!selectedBucket) {
        return;
      }
      bucket = selectedBucket;
    }

    const folders = await showFolderPicker({
      title: "Select folder to upload",
    });

    if (!folders || folders.length === 0) {
      return;
    }

    const folder = folders[0];
    showInformationMessage(
      "Folder upload functionality will be implemented with recursive file walking"
    );

    // TODO: Implement recursive folder upload
    // This would involve:
    // 1. Walking the directory tree
    // 2. Reading all files
    // 3. Uploading with proper key structure
    // 4. Progress tracking for the entire operation
  } catch (error) {
    showErrorMessage(
      `Failed to upload folder: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

async function handleDownload(node: any) {
  try {
    if (!isObjectNode(node)) {
      showErrorMessage("Can only download files");
      return;
    }

    const fileName = getFileName(node.key);
    const saveLocation = await showSaveDialog(fileName);
    if (!saveLocation) {
      return;
    }

    await withDownloadProgress(async (progress) => {
      progress.report({ message: `Downloading ${fileName}...` });
      await downloadFile(
        node.bucket,
        node.key,
        saveLocation.fsPath,
        (progressPercent) => {
          progress.setProgress(
            progressPercent,
            `Downloading ${fileName}... ${progressPercent}%`
          );
        }
      );
    }, fileName);

    showInformationMessage(`Downloaded "${fileName}" successfully`);
  } catch (error) {
    showErrorMessage(
      `Failed to download file: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

async function handleDelete(node: any) {
  try {
    if (isObjectNode(node)) {
      const confirmed = await promptForDestructiveConfirmation(
        "Delete",
        getFileName(node.key)
      );
      if (!confirmed) {
        return;
      }

      await withDeleteProgress(async (progress) => {
        progress.report({ message: "Deleting object..." });
        await deleteObject(node.bucket, node.key);
      }, 1);

      s3Cache.invalidate(node.bucket);
      s3Explorer.refresh();

      showInformationMessage("Object deleted successfully");
    } else if (isPrefixNode(node)) {
      const confirmed = await promptForDestructiveConfirmation(
        "Delete",
        node.prefix
      );
      if (!confirmed) {
        return;
      }

      showInformationMessage(
        "Folder deletion functionality will be implemented with recursive deletion"
      );
      // TODO: Implement recursive folder deletion
    }
  } catch (error) {
    showErrorMessage(
      `Failed to delete: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleCopy(node: any) {
  showInformationMessage("Copy functionality will be implemented");
  // TODO: Implement copy with target selection
}

async function handleMove(node: any) {
  showInformationMessage("Move functionality will be implemented");
  // TODO: Implement move with target selection
}

async function handleRename(node: any) {
  showInformationMessage("Rename functionality will be implemented");
  // TODO: Implement rename (copy to new key + delete old key)
}

async function handleGeneratePresignedUrl(node: any) {
  try {
    if (!isObjectNode(node)) {
      showErrorMessage("Can only generate URLs for objects");
      return;
    }

    const expiresIn = await promptForPresignedUrlExpiry();
    if (expiresIn === undefined) {
      return;
    }

    let url: string;
    let message: string;

    if (expiresIn === 0) {
      // Generate public URL (permanent link)
      url = generatePublicUrl(node.bucket, node.key);
      message = "Public URL copied to clipboard (permanent)";
    } else {
      // Generate presigned URL
      url = await generatePresignedUrl(node.bucket, node.key, { expiresIn });
      const minutes = Math.round(expiresIn / 60);
      const hours = Math.round(expiresIn / 3600);
      const days = Math.round(expiresIn / 86400);

      let timeStr: string;
      if (days >= 1) {
        timeStr = `${days} day${days > 1 ? "s" : ""}`;
      } else if (hours >= 1) {
        timeStr = `${hours} hour${hours > 1 ? "s" : ""}`;
      } else {
        timeStr = `${minutes} minute${minutes > 1 ? "s" : ""}`;
      }

      message = `Presigned URL copied to clipboard (expires in ${timeStr})`;
    }

    await vscode.env.clipboard.writeText(url);
    showInformationMessage(message);
  } catch (error) {
    showErrorMessage(
      `Failed to generate URL: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleGeneratePublicUrl(node: any) {
  try {
    if (!isObjectNode(node)) {
      showErrorMessage("Can only generate URLs for objects");
      return;
    }

    const config = getConfig();
    const url = generatePublicUrl(node.bucket, node.key, config.includeBucketInPublicUrl);
    await vscode.env.clipboard.writeText(url);
    showInformationMessage("Public URL copied to clipboard (permanent)");
  } catch (error) {
    showErrorMessage(
      `Failed to generate public URL: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleSearch() {
  try {
    const searchParams = await promptForSearchTerm();
    if (!searchParams) {
      return;
    }

    const bucket = await promptForBucket("Select bucket to search");
    if (!bucket) {
      return;
    }

    await withProgress(
      {
        title: "Searching objects",
        location: vscode.ProgressLocation.Notification,
      },
      async (progress) => {
        progress.report({ message: "Searching..." });

        const results = await searchObjects(
          bucket,
          searchParams.prefix,
          searchParams.contains,
          1000
        );

        if (results.length === 0) {
          showInformationMessage(
            "No objects found matching the search criteria"
          );
          return;
        }

        // Show results in a quick pick
        const quickPickItems = results.map((obj) => ({
          label: getFileName(obj.key),
          description: obj.key,
          detail: `${obj.size ? `${Math.round(obj.size / 1024)} KB` : ""} ${
            obj.lastModified ? obj.lastModified.toLocaleDateString() : ""
          }`.trim(),
        }));

        const selected = await vscode.window.showQuickPick(quickPickItems, {
          placeHolder: `Found ${results.length} objects. Select one to open.`,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (selected) {
          const uri = vscode.Uri.parse(
            `s3x://${bucket}/${selected.description}`
          );
          await vscode.commands.executeCommand("vscode.open", uri);
        }
      }
    );
  } catch (error) {
    showErrorMessage(
      `Search failed: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleShowMetadata(node: any) {
  try {
    if (!isObjectNode(node)) {
      showErrorMessage("Can only show metadata for objects");
      return;
    }

    const metadata = await getObjectMetadata(node.bucket, node.key);

    const items = [
      `**Object:** ${node.key}`,
      `**Bucket:** ${node.bucket}`,
      `**Size:** ${
        metadata.contentLength ? `${metadata.contentLength} bytes` : "Unknown"
      }`,
      `**Content Type:** ${metadata.contentType || "Unknown"}`,
      `**Last Modified:** ${
        metadata.lastModified
          ? metadata.lastModified.toLocaleString()
          : "Unknown"
      }`,
      `**ETag:** ${metadata.etag || "Unknown"}`,
      `**Storage Class:** ${metadata.storageClass || "Standard"}`,
    ];

    if (metadata.serverSideEncryption) {
      items.push(`**Encryption:** ${metadata.serverSideEncryption}`);
    }

    if (metadata.metadata && Object.keys(metadata.metadata).length > 0) {
      items.push("**Custom Metadata:**");
      for (const [key, value] of Object.entries(metadata.metadata)) {
        items.push(`  - ${key}: ${value}`);
      }
    }

    const content = items.join("\n\n");

    // Create a temporary document to show the metadata
    const doc = await vscode.workspace.openTextDocument({
      content,
      language: "markdown",
    });

    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (error) {
    showErrorMessage(
      `Failed to get metadata: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

async function handleSmokeTest() {
  try {
    await withProgress(
      {
        title: "Running S3/R2 smoke test",
        location: vscode.ProgressLocation.Notification,
      },
      async (progress) => {
        progress.report({ message: "Testing connection..." });
        await testConnection();

        progress.report({ message: "Listing buckets...", increment: 25 });
        const buckets = await listBuckets();

        if (buckets.length === 0) {
          showInformationMessage(
            "Smoke test passed: Connection successful but no buckets found"
          );
          return;
        }

        const testBucket = buckets[0].name;
        progress.report({
          message: `Listing objects in ${testBucket}...`,
          increment: 25,
        });

        // List first 10 objects in the first bucket
        const result = await searchObjects(
          testBucket,
          undefined,
          undefined,
          10
        );

        progress.report({ message: "Creating test object...", increment: 25 });

        // Create a test object
        const testKey = `_s3x_test_${Date.now()}.txt`;
        const testContent = `S3/R2 Explorer smoke test\nTimestamp: ${new Date().toISOString()}`;

        await createFolder(testBucket, "test-folder/");
        await uploadFile(testBucket, testKey, "test-content", (prog) => {
          // Upload progress
        });

        progress.report({
          message: "Cleaning up test object...",
          increment: 15,
        });

        // Clean up test object
        await deleteObject(testBucket, testKey);
        await deleteObject(testBucket, "test-folder/");

        progress.setProgress(100, "Smoke test completed");
      }
    );

    showInformationMessage(
      "✅ Smoke test passed! S3/R2 Explorer is working correctly."
    );
  } catch (error) {
    showErrorMessage(
      `❌ Smoke test failed: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleOpenFile(node: any) {
  try {
    if (!isObjectNode(node)) {
      showErrorMessage("Invalid object node");
      return;
    }

    const { bucket, key } = node;

    // Check if this is a media file
    if (isImageFile(key) || isVideoFile(key) || isAudioFile(key)) {
      // Auto-preview media files
      await handlePreviewMedia({
        bucket,
        key,
        uri: node.resourceUri,
      });
    } else {
      // Open non-media files using the default VS Code behavior
      // This will go through our file system provider
      await vscode.commands.executeCommand("vscode.open", node.resourceUri);
    }
  } catch (error) {
    showErrorMessage(
      `Failed to open file: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handlePreviewMedia(params: any) {
  try {
    const { bucket, key, uri } = params;

    // Generate a presigned URL for the media file
    const presignedUrl = await generatePresignedUrl(bucket, key, {
      expiresIn: 3600, // 1 hour
    });

    // Create HTML content for the preview
    const mediaType = isImageFile(key)
      ? "image"
      : isVideoFile(key)
      ? "video"
      : "audio";

    let htmlContent: string;
    if (mediaType === "image") {
      htmlContent = createImagePreviewHtml(key, presignedUrl);
    } else if (mediaType === "video") {
      htmlContent = createVideoPreviewHtml(key, presignedUrl);
    } else {
      htmlContent = createAudioPreviewHtml(key, presignedUrl);
    }

    // Create and show webview
    const panel = vscode.window.createWebviewPanel(
      "s3xMediaPreview",
      `Preview: ${getFileName(key)}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    panel.webview.html = htmlContent;
  } catch (error) {
    showErrorMessage(
      `Failed to preview media: ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

function createImagePreviewHtml(key: string, url: string): string {
  const fileName = getFileName(key);
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Preview: ${fileName}</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
        }
        .header {
            margin-bottom: 20px;
            text-align: center;
        }
        .filename {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .container {
            max-width: 100%;
            text-align: center;
        }
        .image {
            max-width: 100%;
            max-height: 80vh;
            object-fit: contain;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 20px;
            border: 1px solid var(--vscode-errorBorder);
            border-radius: 4px;
            background-color: var(--vscode-inputValidation-errorBackground);
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="filename">${fileName}</div>
        <div>S3/R2 Object: ${key}</div>
    </div>
    <div class="container">
        <img class="image" src="${url}" alt="${fileName}" 
             onerror="this.style.display='none'; document.getElementById('error').style.display='block';" />
        <div id="error" class="error" style="display:none;">
            Failed to load image. The presigned URL may have expired or the file may be corrupted.
        </div>
    </div>
</body>
</html>`;
}

function createVideoPreviewHtml(key: string, url: string): string {
  const fileName = getFileName(key);
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video Preview: ${fileName}</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
        }
        .header {
            margin-bottom: 20px;
            text-align: center;
        }
        .filename {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .container {
            max-width: 100%;
            text-align: center;
        }
        .video {
            max-width: 100%;
            max-height: 80vh;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 20px;
            border: 1px solid var(--vscode-errorBorder);
            border-radius: 4px;
            background-color: var(--vscode-inputValidation-errorBackground);
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="filename">${fileName}</div>
        <div>S3/R2 Object: ${key}</div>
    </div>
    <div class="container">
        <video class="video" controls preload="metadata"
               onerror="this.style.display='none'; document.getElementById('error').style.display='block';">
            <source src="${url}" type="video/mp4">
            Your browser does not support the video tag.
        </video>
        <div id="error" class="error" style="display:none;">
            Failed to load video. The presigned URL may have expired or the video format may not be supported.
        </div>
    </div>
</body>
</html>`;
}

function createAudioPreviewHtml(key: string, url: string): string {
  const fileName = getFileName(key);
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Audio Preview: ${fileName}</title>
    <style>
        body {
            margin: 0;
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 100vh;
        }
        .header {
            margin-bottom: 20px;
            text-align: center;
        }
        .filename {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 10px;
        }
        .container {
            max-width: 100%;
            text-align: center;
        }
        .audio {
            width: 100%;
            max-width: 600px;
        }
        .error {
            color: var(--vscode-errorForeground);
            padding: 20px;
            border: 1px solid var(--vscode-errorBorder);
            border-radius: 4px;
            background-color: var(--vscode-inputValidation-errorBackground);
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="filename">${fileName}</div>
        <div>S3/R2 Object: ${key}</div>
    </div>
    <div class="container">
        <audio class="audio" controls preload="metadata"
               onerror="this.style.display='none'; document.getElementById('error').style.display='block';">
            <source src="${url}" type="audio/mpeg">
            Your browser does not support the audio tag.
        </audio>
        <div id="error" class="error" style="display:none;">
            Failed to load audio. The presigned URL may have expired or the audio format may not be supported.
        </div>
    </div>
</body>
</html>`;
}
