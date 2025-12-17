import * as vscode from "vscode";
import * as path from "path";
import { S3Explorer } from "./tree/explorer";
import { S3FileSystemProvider } from "./fs/provider";
import { listBuckets, searchObjects, listAllObjectsRecursive } from "./s3/listing";
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
  promptForS3FolderPath,
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

// Clipboard for copy/cut operations
interface ClipboardItem {
  bucket: string;
  key?: string;
  prefix?: string;
  operation: "copy" | "cut";
  itemType: "file" | "folder";
}

let clipboard: ClipboardItem | undefined;

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

async function handleFilterTree() {
  try {
    const currentFilter = s3Explorer.getFilterText();

    const filterText = await vscode.window.showInputBox({
      title: "Filter Tree View",
      placeHolder: "Enter text to filter (case-insensitive)",
      prompt: "Search by bucket, folder, or file name",
      value: currentFilter,
    });

    if (filterText === undefined) {
      return; // User cancelled
    }

    if (filterText === "") {
      // Empty string means clear filter
      s3Explorer.clearFilter();
      await vscode.commands.executeCommand(
        "setContext",
        "s3x.filterActive",
        false
      );
      showInformationMessage("Filter cleared");
    } else {
      s3Explorer.setFilter(filterText);
      await vscode.commands.executeCommand(
        "setContext",
        "s3x.filterActive",
        true
      );
      showInformationMessage(`Filtering tree by: "${filterText}"`);
    }
  } catch (error) {
    showErrorMessage(
      `Failed to filter tree: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleClearFilter() {
  try {
    s3Explorer.clearFilter();
    await vscode.commands.executeCommand(
      "setContext",
      "s3x.filterActive",
      false
    );
    showInformationMessage("Filter cleared");
  } catch (error) {
    showErrorMessage(
      `Failed to clear filter: ${error instanceof Error ? error.message : error}`
    );
  }
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
    vscode.commands.registerCommand("s3x.filterTree", async () => {
      await handleFilterTree();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.clearFilter", async () => {
      await handleClearFilter();
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
    vscode.commands.registerCommand("s3x.cut", async (node) => {
      await handleCut(node);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("s3x.paste", async (node) => {
      await handlePaste(node);
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

    const folderPath = folders[0].fsPath;
    const folderName = path.basename(folderPath);
    const fs = await import("fs");
    const config = getConfig();

    // Recursively collect all files (moved outside withProgress)
    const files: { localPath: string; relativePath: string }[] = [];

    async function scanDirectory(dirPath: string, relativeTo: string) {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(relativeTo, fullPath);

        if (entry.isDirectory()) {
          await scanDirectory(fullPath, relativeTo);
        } else if (entry.isFile()) {
          files.push({
            localPath: fullPath,
            relativePath: relativePath.replace(/\\/g, "/"), // Normalize to forward slashes
          });
        }
      }
    }

    // Scan directory first
    await scanDirectory(folderPath, folderPath);

    if (files.length === 0) {
      showInformationMessage("No files found in the selected folder");
      return;
    }

    await withProgress(
      {
        title: `Uploading folder "${folderName}"`,
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({
          message: `Found ${files.length} file${files.length > 1 ? "s" : ""}, starting upload...`
        });

        // Upload each file
        let uploadedCount = 0;
        for (const file of files) {
          if (token.isCancellationRequested) {
            throw new Error("Upload cancelled");
          }

          const originalFileName = path.basename(file.relativePath);
          const fileName = applyFileNameTemplate(originalFileName, config.uploadFileNameTemplate);
          const fileDir = path.dirname(file.relativePath);
          const s3Key = joinPath(
            prefix,
            folderName,
            fileDir === "." ? fileName : joinPath(fileDir, fileName)
          );

          progress.report({
            message: `Uploading ${uploadedCount + 1}/${files.length}: ${file.relativePath}`,
            increment: (1 / files.length) * 100,
          });

          await uploadFile(bucket, s3Key, file.localPath);
          uploadedCount++;
        }

        progress.report({ message: "Upload completed!" });
      }
    );

    // Invalidate cache and refresh
    s3Cache.invalidate(bucket, prefix);
    s3Explorer.refresh(node);

    showInformationMessage(
      `Uploaded folder "${folderName}" with ${files.length} file${files.length > 1 ? "s" : ""} successfully`
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Upload cancelled") {
      showInformationMessage("Folder upload cancelled");
    } else {
      showErrorMessage(
        `Failed to upload folder: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
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

      await withProgress(
        {
          title: `Deleting folder "${node.prefix}"`,
          location: vscode.ProgressLocation.Notification,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Listing objects in folder..." });

          // List all objects under the prefix (recursive to get all nested files)
          const objects = await listAllObjectsRecursive(node.bucket, node.prefix);

          if (objects.length === 0) {
            // Empty folder - just delete the folder marker
            progress.report({ message: "Deleting empty folder..." });
            await deleteObject(node.bucket, node.prefix);
          } else {
            // Delete all objects in batches
            progress.report({
              message: `Found ${objects.length} object${objects.length > 1 ? "s" : ""}, deleting...`
            });

            const batchSize = 1000; // S3 deleteObjects supports up to 1000 keys per request
            const totalBatches = Math.ceil(objects.length / batchSize);

            for (let i = 0; i < totalBatches; i++) {
              const start = i * batchSize;
              const end = Math.min(start + batchSize, objects.length);
              const batch = objects.slice(start, end);
              const keys = batch.map(obj => obj.key);

              progress.report({
                message: `Deleting batch ${i + 1}/${totalBatches} (${keys.length} objects)...`,
                increment: (1 / totalBatches) * 100,
              });

              await deleteObjects(node.bucket, keys);
            }

            // Delete the folder marker if it exists
            progress.report({ message: "Cleaning up folder marker..." });
            try {
              await deleteObject(node.bucket, node.prefix);
            } catch (error) {
              // Ignore error if folder marker doesn't exist
              console.log("Folder marker already deleted or doesn't exist");
            }
          }

          progress.report({ message: "Deletion completed!" });
        }
      );

      s3Cache.invalidate(node.bucket);
      s3Explorer.refresh();

      showInformationMessage("Folder deleted successfully");
    }
  } catch (error) {
    showErrorMessage(
      `Failed to delete: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleCopy(node: any) {
  try {
    if (!isObjectNode(node) && !isPrefixNode(node)) {
      showErrorMessage("Can only copy files or folders");
      return;
    }

    // Store in clipboard
    if (isObjectNode(node)) {
      clipboard = {
        bucket: node.bucket,
        key: node.key,
        operation: "copy",
        itemType: "file",
      };
      showInformationMessage(`Copied "${getFileName(node.key)}" to clipboard`);
    } else if (isPrefixNode(node)) {
      clipboard = {
        bucket: node.bucket,
        prefix: node.prefix,
        operation: "copy",
        itemType: "folder",
      };
      const folderName = node.prefix.endsWith("/")
        ? node.prefix.slice(0, -1).split("/").pop()
        : node.prefix.split("/").pop();
      showInformationMessage(`Copied folder "${folderName}" to clipboard`);
    }
  } catch (error) {
    showErrorMessage(
      `Failed to copy: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleCut(node: any) {
  try {
    if (!isObjectNode(node) && !isPrefixNode(node)) {
      showErrorMessage("Can only cut files or folders");
      return;
    }

    // Store in clipboard with cut operation
    if (isObjectNode(node)) {
      clipboard = {
        bucket: node.bucket,
        key: node.key,
        operation: "cut",
        itemType: "file",
      };
      showInformationMessage(`Cut "${getFileName(node.key)}" to clipboard`);
    } else if (isPrefixNode(node)) {
      clipboard = {
        bucket: node.bucket,
        prefix: node.prefix,
        operation: "cut",
        itemType: "folder",
      };
      const folderName = node.prefix.endsWith("/")
        ? node.prefix.slice(0, -1).split("/").pop()
        : node.prefix.split("/").pop();
      showInformationMessage(`Cut folder "${folderName}" to clipboard`);
    }
  } catch (error) {
    showErrorMessage(
      `Failed to cut: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handlePaste(node: any) {
  try {
    if (!clipboard) {
      showErrorMessage("Clipboard is empty. Copy or cut an item first.");
      return;
    }

    // Determine target location
    let targetBucket: string;
    let targetPrefix = "";

    if (isBucketNode(node)) {
      targetBucket = node.bucket;
    } else if (isPrefixNode(node)) {
      targetBucket = node.bucket;
      targetPrefix = node.prefix;
    } else {
      showErrorMessage("Please select a bucket or folder to paste into");
      return;
    }

    // Perform paste operation
    if (clipboard.itemType === "file" && clipboard.key) {
      await handlePasteFile(clipboard, targetBucket, targetPrefix);
    } else if (clipboard.itemType === "folder" && clipboard.prefix) {
      await handlePasteFolder(clipboard, targetBucket, targetPrefix);
    }

    // Clear clipboard if it was a cut operation
    if (clipboard.operation === "cut") {
      clipboard = undefined;
    }
  } catch (error) {
    showErrorMessage(
      `Failed to paste: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handlePasteFile(
  clipboardItem: ClipboardItem,
  targetBucket: string,
  targetPrefix: string
) {
  const fileName = getFileName(clipboardItem.key!);
  const targetKey = targetPrefix ? joinPath(targetPrefix, fileName) : fileName;

  if (clipboardItem.operation === "copy") {
    await withCopyProgress(async (progress) => {
      progress.report({ message: `Copying ${fileName}...` });
      await copyObject(clipboardItem.bucket, clipboardItem.key!, targetBucket, targetKey);
    }, 1);

    s3Cache.invalidate(targetBucket);
    s3Explorer.refresh();

    showInformationMessage(`Pasted "${fileName}" successfully`);
  } else {
    // Cut operation - move the file
    await withMoveProgress(async (progress) => {
      progress.report({ message: `Moving ${fileName}...` });
      await moveObject(clipboardItem.bucket, clipboardItem.key!, targetBucket, targetKey);
    }, 1);

    s3Cache.invalidate(clipboardItem.bucket);
    s3Cache.invalidate(targetBucket);
    s3Explorer.refresh();

    showInformationMessage(`Moved "${fileName}" successfully`);
  }
}

async function handlePasteFolder(
  clipboardItem: ClipboardItem,
  targetBucket: string,
  targetPrefix: string
) {
  const sourceFolderName = clipboardItem.prefix!.endsWith("/")
    ? clipboardItem.prefix!.slice(0, -1).split("/").pop()
    : clipboardItem.prefix!.split("/").pop();

  const targetFolderPrefix = targetPrefix
    ? joinPath(targetPrefix, sourceFolderName!) + "/"
    : sourceFolderName + "/";

  const operationName = clipboardItem.operation === "copy" ? "Copying" : "Moving";

  await withProgress(
    {
      title: `${operationName} folder "${sourceFolderName}"`,
      location: vscode.ProgressLocation.Notification,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Listing objects in folder..." });

      // List all objects under the source prefix (recursive to get all nested files)
      const objects = await listAllObjectsRecursive(clipboardItem.bucket, clipboardItem.prefix!);

      if (objects.length === 0) {
        // Empty folder - just create the target folder marker
        await createFolder(targetBucket, targetFolderPrefix);

        if (clipboardItem.operation === "cut") {
          await deleteObject(clipboardItem.bucket, clipboardItem.prefix!);
        }
      } else {
        // Process each object
        const totalObjects = objects.length;
        let processedObjects = 0;

        for (const obj of objects) {
          const relativePath = obj.key.substring(clipboardItem.prefix!.length);
          const targetKey = targetFolderPrefix + relativePath;

          progress.report({
            message: `${operationName} ${processedObjects + 1}/${totalObjects}: ${relativePath}`,
            increment: (1 / totalObjects) * 100,
          });

          if (clipboardItem.operation === "copy") {
            await copyObject(clipboardItem.bucket, obj.key, targetBucket, targetKey);
          } else {
            await moveObject(clipboardItem.bucket, obj.key, targetBucket, targetKey);
          }
          processedObjects++;
        }

        // Create target folder marker if it doesn't exist
        try {
          await createFolder(targetBucket, targetFolderPrefix);
        } catch (error) {
          // Ignore if already exists
        }

        if (clipboardItem.operation === "cut") {
          progress.report({ message: "Cleaning up source folder..." });

          // List all remaining objects with the source prefix to clean up any folder markers
          const remainingObjects = await listAllObjectsRecursive(clipboardItem.bucket, clipboardItem.prefix!);

          // Delete any remaining folder markers (objects ending with /)
          for (const obj of remainingObjects) {
            if (obj.key.endsWith("/")) {
              try {
                await deleteObject(clipboardItem.bucket, obj.key);
              } catch (error) {
                console.log(`Failed to delete folder marker ${obj.key}:`, error);
              }
            }
          }

          // Delete the main folder marker
          try {
            await deleteObject(clipboardItem.bucket, clipboardItem.prefix!);
          } catch (error) {
            console.log("Source folder marker already deleted or doesn't exist");
          }
        }
      }

      progress.report({ message: `${operationName} completed!` });
    }
  );

  if (clipboardItem.operation === "cut") {
    s3Cache.invalidate(clipboardItem.bucket);
  }
  s3Cache.invalidate(targetBucket);
  s3Explorer.refresh();

  const operationPast = clipboardItem.operation === "copy" ? "Copied" : "Moved";
  showInformationMessage(`${operationPast} folder "${sourceFolderName}" successfully`);
}

async function handleMove(node: any) {
  try {
    if (!isObjectNode(node) && !isPrefixNode(node)) {
      showErrorMessage("Can only move files or folders");
      return;
    }

    // Get source info
    const sourceBucket = isObjectNode(node) ? node.bucket : node.bucket;
    const sourceKey = isObjectNode(node) ? node.key : node.prefix;
    const itemType = isObjectNode(node) ? "file" : "folder";
    const itemName = isObjectNode(node) ? getFileName(node.key) : node.prefix;

    // Select target bucket
    const targetBucket = await promptForBucket("Select destination bucket");
    if (!targetBucket) {
      return;
    }

    // Use folder picker to select target prefix
    const targetPrefix = await promptForS3FolderPath(targetBucket, "");

    if (targetPrefix === undefined) {
      return;
    }

    if (isObjectNode(node)) {
      // Move single file
      await handleMoveFile(node, targetBucket, targetPrefix);
    } else if (isPrefixNode(node)) {
      // Move folder
      await handleMoveFolder(node, targetBucket, targetPrefix);
    }
  } catch (error) {
    showErrorMessage(
      `Failed to move: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleMoveFile(node: any, targetBucket: string, targetPrefix: string) {
  const fileName = getFileName(node.key);
  const targetKey = targetPrefix ? joinPath(targetPrefix, fileName) : fileName;

  await withMoveProgress(async (progress) => {
    progress.report({ message: `Moving ${fileName}...` });
    await moveObject(node.bucket, node.key, targetBucket, targetKey);
  }, 1);

  s3Cache.invalidate(node.bucket);
  s3Cache.invalidate(targetBucket);
  s3Explorer.refresh();

  showInformationMessage(`Moved "${fileName}" successfully`);
}

async function handleMoveFolder(node: any, targetBucket: string, targetPrefix: string) {
  const sourceFolderName = node.prefix.endsWith("/")
    ? node.prefix.slice(0, -1).split("/").pop()
    : node.prefix.split("/").pop();

  const targetFolderPrefix = targetPrefix
    ? joinPath(targetPrefix, sourceFolderName) + "/"
    : sourceFolderName + "/";

  await withProgress(
    {
      title: `Moving folder "${sourceFolderName}"`,
      location: vscode.ProgressLocation.Notification,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Listing objects in folder..." });

      // List all objects under the source prefix (recursive to get all nested files)
      const objects = await listAllObjectsRecursive(node.bucket, node.prefix);

      if (objects.length === 0) {
        // Empty folder - just create the target folder marker and delete source
        await createFolder(targetBucket, targetFolderPrefix);
        await deleteObject(node.bucket, node.prefix);
      } else {
        // Move each object
        const totalObjects = objects.length;
        let processedObjects = 0;

        for (const obj of objects) {
          const relativePath = obj.key.substring(node.prefix.length);
          const targetKey = targetFolderPrefix + relativePath;

          progress.report({
            message: `Moving ${processedObjects + 1}/${totalObjects}: ${relativePath}`,
            increment: (1 / totalObjects) * 100,
          });

          await moveObject(node.bucket, obj.key, targetBucket, targetKey);
          processedObjects++;
        }

        // Delete source folder marker
        progress.report({ message: "Cleaning up source folder..." });

        // List remaining objects to clean up all folder markers
        const remainingObjects = await listAllObjectsRecursive(node.bucket, node.prefix);

        // Delete any remaining folder markers (objects ending with /)
        for (const obj of remainingObjects) {
          if (obj.key.endsWith("/")) {
            try {
              await deleteObject(node.bucket, obj.key);
            } catch (error) {
              console.log(`Failed to delete folder marker ${obj.key}:`, error);
            }
          }
        }

        // Delete the main folder marker
        try {
          await deleteObject(node.bucket, node.prefix);
        } catch (error) {
          // Ignore error if folder marker doesn't exist
          console.log("Source folder marker already deleted or doesn't exist");
        }
      }

      progress.report({ message: "Move completed!" });
    }
  );

  s3Cache.invalidate(node.bucket);
  s3Cache.invalidate(targetBucket);
  s3Explorer.refresh();

  showInformationMessage(`Moved folder "${sourceFolderName}" successfully`);
}

async function handleRename(node: any) {
  try {
    if (isPrefixNode(node)) {
      // Handle folder rename
      await handleRenameFolder(node);
    } else if (isObjectNode(node)) {
      // Handle file rename
      await handleRenameFile(node);
    } else {
      showErrorMessage("Can only rename files or folders");
    }
  } catch (error) {
    showErrorMessage(
      `Failed to rename: ${error instanceof Error ? error.message : error}`
    );
  }
}

async function handleRenameFile(node: any) {
  const oldFileName = getFileName(node.key);
  const newFileName = await vscode.window.showInputBox({
    title: "Rename File",
    placeHolder: "Enter new file name",
    value: oldFileName,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "File name cannot be empty";
      }
      if (value.includes("/")) {
        return "File name cannot contain slashes";
      }
      if (value === oldFileName) {
        return "New name must be different from current name";
      }
      return undefined;
    },
  });

  if (!newFileName) {
    return;
  }

  // Calculate new key by replacing the filename part
  const keyParts = node.key.split("/");
  keyParts[keyParts.length - 1] = newFileName;
  const newKey = keyParts.join("/");

  await withMoveProgress(async (progress) => {
    progress.report({ message: `Renaming ${oldFileName}...` });
    await moveObject(node.bucket, node.key, node.bucket, newKey);
  }, 1);

  // Invalidate cache and refresh
  const prefix = keyParts.slice(0, -1).join("/");
  s3Cache.invalidate(node.bucket, prefix);
  s3Explorer.refresh();

  showInformationMessage(`Renamed "${oldFileName}" to "${newFileName}" successfully`);
}

async function handleRenameFolder(node: any) {
  const oldPrefix = node.prefix;
  const oldFolderName = oldPrefix.endsWith("/")
    ? oldPrefix.slice(0, -1).split("/").pop()
    : oldPrefix.split("/").pop();

  const newFolderName = await vscode.window.showInputBox({
    title: "Rename Folder",
    placeHolder: "Enter new folder name",
    value: oldFolderName,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "Folder name cannot be empty";
      }
      if (value.includes("/")) {
        return "Folder name cannot contain slashes";
      }
      if (value === oldFolderName) {
        return "New name must be different from current name";
      }
      return undefined;
    },
  });

  if (!newFolderName) {
    return;
  }

  // Calculate new prefix by replacing the folder name part
  const prefixParts = oldPrefix.split("/").filter(p => p);
  prefixParts[prefixParts.length - 1] = newFolderName;
  const newPrefix = prefixParts.join("/") + "/";

  await withProgress(
    {
      title: `Renaming folder "${oldFolderName}"`,
      location: vscode.ProgressLocation.Notification,
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Listing objects in folder..." });

      // List all objects under the old prefix (recursive to get all nested files)
      const objects = await listAllObjectsRecursive(node.bucket, oldPrefix);

      if (objects.length === 0) {
        // Empty folder - just create the new folder marker and delete old one
        await createFolder(node.bucket, newPrefix);
        await deleteObject(node.bucket, oldPrefix);
      } else {
        // Rename each object by moving to new prefix
        const totalObjects = objects.length;
        let processedObjects = 0;

        for (const obj of objects) {
          const relativePath = obj.key.substring(oldPrefix.length);
          const newKey = newPrefix + relativePath;

          progress.report({
            message: `Moving ${processedObjects + 1}/${totalObjects}: ${relativePath}`,
            increment: (1 / totalObjects) * 100,
          });

          await moveObject(node.bucket, obj.key, node.bucket, newKey);
          processedObjects++;
        }

        // Delete the old folder marker if it exists
        progress.report({ message: "Cleaning up old folder..." });

        // List remaining objects to clean up all folder markers
        const remainingObjects = await listAllObjectsRecursive(node.bucket, oldPrefix);

        // Delete any remaining folder markers (objects ending with /)
        for (const obj of remainingObjects) {
          if (obj.key.endsWith("/")) {
            try {
              await deleteObject(node.bucket, obj.key);
            } catch (error) {
              console.log(`Failed to delete folder marker ${obj.key}:`, error);
            }
          }
        }

        // Delete the main old folder marker
        try {
          await deleteObject(node.bucket, oldPrefix);
        } catch (error) {
          // Ignore error if folder marker doesn't exist
          console.log("Old folder marker already deleted or doesn't exist");
        }
      }

      progress.report({ message: "Completing rename..." });
    }
  );

  // Invalidate cache and refresh
  const parentPrefix = prefixParts.slice(0, -1).join("/");
  s3Cache.invalidate(node.bucket, parentPrefix);
  s3Explorer.refresh();

  showInformationMessage(`Renamed folder "${oldFolderName}" to "${newFolderName}" successfully`);
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
          key: obj.key,
        }));

        const selected = await vscode.window.showQuickPick(quickPickItems, {
          placeHolder: `Found ${results.length} objects. Select one to reveal in tree or open.`,
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (selected) {
          // Show action menu
          const action = await vscode.window.showQuickPick(
            [
              {
                label: "$(eye) Reveal in Tree",
                description: "Show the file in the S3 Explorer tree view",
                value: "reveal",
              },
              {
                label: "$(file) Open File",
                description: "Open the file in the editor",
                value: "open",
              },
            ],
            {
              placeHolder: `Selected: ${selected.label}`,
            }
          );

          if (!action) {
            return;
          }

          if (action.value === "reveal") {
            // Find and reveal the node in tree
            progress.report({ message: "Locating file in tree..." });
            const node = await s3Explorer.findNode(bucket, selected.key);

            if (node) {
              await s3TreeView.reveal(node, {
                select: true,
                focus: true,
                expand: true,
              });
              showInformationMessage(`Revealed "${selected.label}" in tree`);
            } else {
              showErrorMessage(
                `Could not locate "${selected.label}" in tree. Try refreshing the explorer.`
              );
            }
          } else if (action.value === "open") {
            // Open the file
            const uri = vscode.Uri.parse(`s3x://${bucket}/${selected.key}`);
            await vscode.commands.executeCommand("vscode.open", uri);
          }
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
