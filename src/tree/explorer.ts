import * as vscode from "vscode";
import * as path from "path";
import { listBuckets, listObjects } from "../s3/listing";
import { S3Error } from "../types";
import { s3Cache } from "../util/cache";
import { uploadFile } from "../s3/ops";
import { joinPath, applyFileNameTemplate } from "../util/paths";
import { getConfig } from "../s3/client";
import {
  BaseTreeNode,
  BucketNode,
  PrefixNode,
  ObjectNode,
  LoadMoreNode,
  createBucketNode,
  createPrefixNode,
  createObjectNode,
  createLoadMoreNode,
  isBucketNode,
  isPrefixNode,
  isObjectNode,
  isLoadMoreNode,
} from "./nodes";

export class S3Explorer
  implements
    vscode.TreeDataProvider<BaseTreeNode>,
    vscode.TreeDragAndDropController<BaseTreeNode>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    BaseTreeNode | undefined | null | void
  > = new vscode.EventEmitter<BaseTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    BaseTreeNode | undefined | null | void
  > = this._onDidChangeTreeData.event;

  // Drag and drop support
  dropMimeTypes = ["application/vnd.code.tree.s3xExplorer", "files", "text/uri-list"];
  dragMimeTypes = ["text/uri-list", "application/vnd.code.tree.s3xExplorer"];

  // Filter state
  private filterText: string = "";
  private filterActive: boolean = false;

  constructor() {}

  // Filter methods
  setFilter(filterText: string): void {
    this.filterText = filterText.toLowerCase();
    this.filterActive = filterText.length > 0;
    this.refresh();
  }

  clearFilter(): void {
    this.filterText = "";
    this.filterActive = false;
    this.refresh();
  }

  getFilterText(): string {
    return this.filterText;
  }

  isFilterActive(): boolean {
    return this.filterActive;
  }

  fuzzyMatch(pattern: string, text: string): boolean {
  if (!pattern) {
    return true; // Empty pattern matches everything
  }

  return text.toLowerCase().includes(pattern.toLowerCase());
}

  private matchesFilter(node: BaseTreeNode): boolean {
    if (!this.filterActive) {
      return true;
    }

    // Match bucket name (case-insensitive substring match)
    if (isBucketNode(node)) {
      return this.fuzzyMatch(this.filterText, node.bucket);
    }

    // Match prefix (folder) name (case-insensitive substring match)
    if (isPrefixNode(node)) {
      // Match against full path
      return this.fuzzyMatch(this.filterText, node.prefix);
    }

    // Match object key (case-insensitive substring match)
    if (isObjectNode(node)) {
      // Match against full key
      return this.fuzzyMatch(this.filterText, node.key);
    }

    // Always show "Load More" nodes
    if (isLoadMoreNode(node)) {
      return true;
    }

    return false;
  }

  // Check if a bucket contains any matching items
  private async bucketHasMatches(bucket: string): Promise<boolean> {
    try {
      const result = await listObjects(bucket, undefined, undefined, 1000);

      // Check prefixes (folders) - recursively check their contents
      for (const prefixItem of result.prefixes) {
        const node = createPrefixNode(bucket, prefixItem, undefined);
        if (this.matchesFilter(node)) {
          return true;
        }

        // Recursively check if folder contains matches
        const folderHasMatches = await this.prefixHasMatches(bucket, prefixItem.prefix);
        if (folderHasMatches) {
          return true;
        }
      }

      // Check objects
      for (const object of result.objects) {
        const node = createObjectNode(bucket, object, undefined);
        if (this.matchesFilter(node)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error(`Error checking bucket ${bucket} for matches:`, error);
      return false;
    }
  }

  // Filter children and include parent folders if they contain matching items
  private async filterChildren(
    nodes: BaseTreeNode[],
    bucket: string,
    prefix?: string
  ): Promise<BaseTreeNode[]> {
    if (!this.filterActive) {
      return nodes;
    }

    const filteredNodes: BaseTreeNode[] = [];

    for (const node of nodes) {
      // Always include matching objects
      if (isObjectNode(node) && this.matchesFilter(node)) {
        filteredNodes.push(node);
        continue;
      }

      // For folders, check if they or their children match
      if (isPrefixNode(node)) {
        // Check if folder name itself matches
        if (this.matchesFilter(node)) {
          filteredNodes.push(node);
          continue;
        }

        // Check if folder contains matching items
        const hasMatches = await this.prefixHasMatches(bucket, node.prefix);
        if (hasMatches) {
          filteredNodes.push(node);
        }
      }

      // Always include Load More nodes
      if (isLoadMoreNode(node)) {
        filteredNodes.push(node);
      }
    }

    return filteredNodes;
  }

  // Check if a prefix (folder) contains any matching items recursively
  private async prefixHasMatches(
    bucket: string,
    prefix: string
  ): Promise<boolean> {
    try {
      const result = await listObjects(bucket, prefix, undefined, 1000);

      // Check prefixes (subfolders) - recursively check their contents
      for (const prefixItem of result.prefixes) {
        const node = createPrefixNode(bucket, prefixItem, prefix);
        if (this.matchesFilter(node)) {
          return true;
        }

        // Recursively check if subfolder contains matches
        const subfolderHasMatches = await this.prefixHasMatches(bucket, prefixItem.prefix);
        if (subfolderHasMatches) {
          return true;
        }
      }

      // Check objects
      for (const object of result.objects) {
        const node = createObjectNode(bucket, object, prefix);
        if (this.matchesFilter(node)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error(`Error checking prefix ${prefix} for matches:`, error);
      return false;
    }
  }

  refresh(element?: BaseTreeNode): void {
    if (element) {
      // Invalidate cache for specific element
      if (isBucketNode(element)) {
        s3Cache.invalidate(element.bucket);
      } else if (isPrefixNode(element)) {
        s3Cache.invalidate(element.bucket, element.prefix);
      }
    } else {
      // Clear all cache
      s3Cache.invalidateAll();
    }

    this._onDidChangeTreeData.fire(element);
  }

  getTreeItem(element: BaseTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BaseTreeNode): Promise<BaseTreeNode[]> {
    try {
      if (!element) {
        // Root level - show buckets
        const buckets = await this.getBuckets();

        // If filter is active, only show buckets that contain matching items
        if (this.filterActive) {
          const filteredBuckets: BucketNode[] = [];
          for (const bucket of buckets) {
            const hasMatches = await this.bucketHasMatches(bucket.bucket);
            if (hasMatches) {
              filteredBuckets.push(bucket);
            }
          }
          return filteredBuckets;
        }

        return buckets;
      }

      if (isBucketNode(element)) {
        // Show contents of bucket (root level)
        const contents = await this.getBucketContents(element.bucket);
        return this.filterChildren(contents, element.bucket);
      }

      if (isPrefixNode(element)) {
        // Show contents of prefix
        const contents = await this.getPrefixContents(element.bucket, element.prefix);
        return this.filterChildren(contents, element.bucket, element.prefix);
      }

      if (isLoadMoreNode(element)) {
        // This shouldn't happen as LoadMore nodes are not expandable
        return [];
      }

      // Objects have no children
      return [];
    } catch (error) {
      console.error("Error getting tree children:", error);

      // Check if this is a "bucket doesn't exist" error
      if (
        error instanceof Error &&
        (error.message.includes("does not exist") ||
          error.message.includes("NoSuchBucket") ||
          error.message.includes("The specified bucket does not exist"))
      ) {
        // Clear cache for this specific bucket if it's a bucket/prefix error
        if (element && (isBucketNode(element) || isPrefixNode(element))) {
          const bucketName = isBucketNode(element)
            ? element.bucket
            : element.bucket;
          console.log(`Clearing cache for non-existent bucket: ${bucketName}`);
          s3Cache.invalidate(bucketName);
        }

        // If this is a bucket node that doesn't exist, suggest refreshing the root
        if (element && isBucketNode(element)) {
          vscode.window
            .showErrorMessage(
              `Bucket "${element.bucket}" no longer exists. Would you like to refresh the bucket list?`,
              "Refresh"
            )
            .then((selection) => {
              if (selection === "Refresh") {
                // Refresh from root to reload bucket list
                this.refresh();
              }
            });
          return [];
        }
      }

      if (S3Error.isAuthError(error)) {
        vscode.window
          .showErrorMessage(
            "Authentication failed. Please check your S3 credentials.",
            "Update Credentials"
          )
          .then((selection) => {
            if (selection === "Update Credentials") {
              vscode.commands.executeCommand("s3x.configure");
            }
          });
      } else {
        vscode.window.showErrorMessage(
          `Error loading S3 data: ${
            error instanceof Error ? error.message : error
          }`
        );
      }

      return [];
    }
  }

  private async getBuckets(): Promise<BucketNode[]> {
    const buckets = await listBuckets();
    return buckets.map((bucket) => createBucketNode(bucket));
  }

  private async getBucketContents(
    bucket: string,
    continuationToken?: string
  ): Promise<BaseTreeNode[]> {
    // Check cache first
    const cached = s3Cache.get(bucket);
    if (cached && !continuationToken) {
      return this.createNodesFromCache(bucket, cached, undefined);
    }

    // Fetch from S3
    const result = await listObjects(bucket, undefined, continuationToken);

    if (continuationToken) {
      // Append to cache
      s3Cache.append(
        bucket,
        result.objects,
        result.prefixes,
        result.isTruncated,
        result.continuationToken
      );
    } else {
      // Set new cache
      s3Cache.set(
        bucket,
        result.objects,
        result.prefixes,
        result.isTruncated,
        result.continuationToken
      );
    }

    return this.createNodes(bucket, result, undefined);
  }

  private async getPrefixContents(
    bucket: string,
    prefix: string,
    continuationToken?: string
  ): Promise<BaseTreeNode[]> {
    // Check cache first
    const cached = s3Cache.get(bucket, prefix);
    if (cached && !continuationToken) {
      return this.createNodesFromCache(bucket, cached, prefix);
    }

    // Fetch from S3
    const result = await listObjects(bucket, prefix, continuationToken);

    if (continuationToken) {
      // Append to cache
      s3Cache.append(
        bucket,
        result.objects,
        result.prefixes,
        result.isTruncated,
        result.continuationToken,
        prefix
      );
    } else {
      // Set new cache
      s3Cache.set(
        bucket,
        result.objects,
        result.prefixes,
        result.isTruncated,
        result.continuationToken,
        prefix
      );
    }

    return this.createNodes(bucket, result, prefix);
  }

  private createNodes(
    bucket: string,
    result: any,
    prefix?: string
  ): BaseTreeNode[] {
    const nodes: BaseTreeNode[] = [];

    // Add prefix nodes (folders) - always add all folders when not filtering
    // When filtering, folders are handled by filterChildren
    for (const prefixItem of result.prefixes) {
      nodes.push(createPrefixNode(bucket, prefixItem, prefix));
    }

    // Add object nodes (files) - filter only objects
    for (const object of result.objects) {
      const node = createObjectNode(bucket, object, prefix);
      if (!this.filterActive || this.matchesFilter(node)) {
        nodes.push(node);
      }
    }

    // Add "Load more" node if there are more results
    if (result.isTruncated && result.continuationToken) {
      nodes.push(createLoadMoreNode(bucket, result.continuationToken, prefix));
    }

    return nodes;
  }

  private createNodesFromCache(
    bucket: string,
    cached: any,
    prefix?: string
  ): BaseTreeNode[] {
    const nodes: BaseTreeNode[] = [];

    // Add prefix nodes (folders) - always add all folders when not filtering
    // When filtering, folders are handled by filterChildren
    for (const prefixItem of cached.prefixes) {
      nodes.push(createPrefixNode(bucket, prefixItem, prefix));
    }

    // Add object nodes (files) - filter only objects
    for (const object of cached.objects) {
      const node = createObjectNode(bucket, object, prefix);
      if (!this.filterActive || this.matchesFilter(node)) {
        nodes.push(node);
      }
    }

    // Add "Load more" node if there are more results
    if (cached.isTruncated && cached.continuationToken) {
      nodes.push(createLoadMoreNode(bucket, cached.continuationToken, prefix));
    }

    return nodes;
  }

  async loadMore(node: LoadMoreNode): Promise<void> {
    try {
      if (node.prefix) {
        await this.getPrefixContents(
          node.bucket,
          node.prefix,
          node.continuationToken
        );
      } else {
        await this.getBucketContents(node.bucket, node.continuationToken);
      }

      // Refresh the parent to show new items
      this._onDidChangeTreeData.fire(undefined);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error loading more items: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }

  // Drag and Drop Implementation
  async handleDrag(
    source: readonly BaseTreeNode[],
    treeDataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    const items = source.filter(isObjectNode); // Only allow dragging objects for now

    if (items.length === 0) {
      return;
    }

    // Store the source nodes for internal drag/drop
    treeDataTransfer.set(
      "application/vnd.code.tree.s3xExplorer",
      new vscode.DataTransferItem(items)
    );

    // Also set URI list for external applications
    const uris = items
      .map((item) => item.resourceUri?.toString())
      .filter(Boolean);
    treeDataTransfer.set(
      "text/uri-list",
      new vscode.DataTransferItem(uris.join("\n"))
    );
  }

  async handleDrop(
    target: BaseTreeNode | undefined,
    sources: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    // Handle external file drops from file system
    const filesData = sources.get("files");
    if (filesData) {
      await this.handleFilesDataDrop(target, filesData.value);
      return;
    }

    // Handle internal drag/drop
    const internalDropData = sources.get(
      "application/vnd.code.tree.s3xExplorer"
    );
    if (internalDropData) {
      await this.handleInternalDrop(target, internalDropData.value);
      return;
    }

    // Handle URI list drops
    const uriListData = sources.get("text/uri-list");
    if (uriListData) {
      await this.handleUriListDrop(target, uriListData.value);
      return;
    }
  }

  private async handleFilesDataDrop(
    target: BaseTreeNode | undefined,
    files: vscode.DataTransferFile[]
  ): Promise<void> {
    if (!target || (!isBucketNode(target) && !isPrefixNode(target))) {
      vscode.window.showErrorMessage("Can only upload to buckets or folders");
      return;
    }

    const targetBucket = target.bucket;
    const targetPrefix = isPrefixNode(target) ? target.prefix : "";

    try {
      let uploadCount = 0;
      for (const file of files) {
        try {
          const uri = file.uri;
          if (uri.scheme === "file") {
            const filePath = uri.fsPath;
            const originalFileName = path.basename(filePath);
            const config = getConfig();
            const fileName = applyFileNameTemplate(originalFileName, config.uploadFileNameTemplate);
            const objectKey = joinPath(targetPrefix, fileName);

            await uploadFile(targetBucket, objectKey, filePath);
            uploadCount++;
          }
        } catch (err) {
          console.error(`Failed to upload ${file.name}:`, err);
        }
      }

      if (uploadCount > 0) {
        s3Cache.invalidate(targetBucket, targetPrefix);
        this.refresh(target);
        vscode.window.showInformationMessage(
          `Uploaded ${uploadCount} file${uploadCount > 1 ? "s" : ""} successfully`
        );
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Drop failed: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  private async handleInternalDrop(
    target: BaseTreeNode | undefined,
    sourceNodes: ObjectNode[]
  ): Promise<void> {
    if (!target || (!isBucketNode(target) && !isPrefixNode(target))) {
      vscode.window.showErrorMessage(
        "Can only move/copy objects to buckets or folders"
      );
      return;
    }

    const action = await vscode.window.showQuickPick(["Copy", "Move"], {
      placeHolder: "Choose action for selected objects",
    });

    if (!action) {
      return;
    }

    try {
      // TODO: Implement copy/move logic using the s3/ops module
      vscode.window.showInformationMessage(
        `${action} functionality will be implemented in the copy/move commands`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `${action} failed: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  private async handleUriListDrop(
    target: BaseTreeNode | undefined,
    uriList: string
  ): Promise<void> {
    if (!target || (!isBucketNode(target) && !isPrefixNode(target))) {
      vscode.window.showErrorMessage("Can only upload to buckets or folders");
      return;
    }

    const uris = uriList.split("\n").filter((uri) => uri.trim());
    if (uris.length === 0) {
      return;
    }

    const targetBucket = target.bucket;
    const targetPrefix = isPrefixNode(target) ? target.prefix : "";

    try {
      let uploadCount = 0;
      for (const uriStr of uris) {
        try {
          const uri = vscode.Uri.parse(uriStr);
          if (uri.scheme === "file") {
            const filePath = uri.fsPath;
            const originalFileName = path.basename(filePath);
            const config = getConfig();
            const fileName = applyFileNameTemplate(originalFileName, config.uploadFileNameTemplate);
            const objectKey = joinPath(targetPrefix, fileName);

            await uploadFile(targetBucket, objectKey, filePath);
            uploadCount++;
          }
        } catch (err) {
          console.error(`Failed to upload ${uriStr}:`, err);
        }
      }

      if (uploadCount > 0) {
        s3Cache.invalidate(targetBucket, targetPrefix);
        this.refresh(target);
        vscode.window.showInformationMessage(
          `Uploaded ${uploadCount} file${uploadCount > 1 ? "s" : ""} successfully`
        );
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Drop failed: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  // Public method to get selected nodes (for commands)
  getSelection(): BaseTreeNode[] {
    // This would need to be implemented to track selection
    // For now, return empty array
    return [];
  }

  // Helper method to find a node by its path
  async findNode(
    bucket: string,
    key?: string
  ): Promise<BaseTreeNode | undefined> {
    if (!key) {
      // Looking for bucket node
      const buckets = await this.getBuckets();
      return buckets.find((b) => b.bucket === bucket);
    }

    // Check if key represents a folder (prefix) or an object
    const isFolder = key.endsWith("/");

    // Split the key into path segments
    const segments = key.split("/").filter((s) => s.length > 0);

    if (segments.length === 0) {
      // Empty key, return bucket node
      const buckets = await this.getBuckets();
      return buckets.find((b) => b.bucket === bucket);
    }

    // Traverse the tree level by level
    let currentPrefix = "";
    let currentNodes: BaseTreeNode[] = await this.getBucketContents(bucket);

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLastSegment = i === segments.length - 1;

      if (isLastSegment && !isFolder) {
        // Looking for an object (file)
        const objectKey = key;
        const objectNode = currentNodes.find(
          (n) => isObjectNode(n) && n.key === objectKey
        );

        if (objectNode) {
          return objectNode;
        }

        // Object not found in current page, check if there's more data
        // Load all pages until we find it or run out of pages
        let hasMore = currentNodes.some(isLoadMoreNode);
        while (hasMore && !objectNode) {
          const loadMoreNode = currentNodes.find(isLoadMoreNode) as LoadMoreNode;
          if (loadMoreNode) {
            // Load more items
            if (currentPrefix) {
              await this.getPrefixContents(
                bucket,
                currentPrefix,
                loadMoreNode.continuationToken
              );
            } else {
              await this.getBucketContents(
                bucket,
                loadMoreNode.continuationToken
              );
            }

            // Get updated nodes
            currentNodes = currentPrefix
              ? await this.getPrefixContents(bucket, currentPrefix)
              : await this.getBucketContents(bucket);

            // Check again for the object
            const found = currentNodes.find(
              (n) => isObjectNode(n) && n.key === objectKey
            );
            if (found) {
              return found;
            }

            hasMore = currentNodes.some(isLoadMoreNode);
          } else {
            hasMore = false;
          }
        }

        return undefined;
      } else {
        // Looking for a folder (prefix)
        currentPrefix = currentPrefix
          ? `${currentPrefix}${segment}/`
          : `${segment}/`;

        const prefixNode = currentNodes.find(
          (n) => isPrefixNode(n) && n.prefix === currentPrefix
        );

        if (!prefixNode) {
          // Prefix not found in current page, check if there's more data
          let hasMore = currentNodes.some(isLoadMoreNode);
          while (hasMore) {
            const loadMoreNode = currentNodes.find(
              isLoadMoreNode
            ) as LoadMoreNode;
            if (loadMoreNode) {
              // Load more items
              const parentPrefix =
                currentPrefix.split("/").slice(0, -2).join("/") +
                (currentPrefix.split("/").slice(0, -2).length > 0 ? "/" : "");

              if (parentPrefix) {
                await this.getPrefixContents(
                  bucket,
                  parentPrefix,
                  loadMoreNode.continuationToken
                );
              } else {
                await this.getBucketContents(
                  bucket,
                  loadMoreNode.continuationToken
                );
              }

              // Get updated nodes
              currentNodes = parentPrefix
                ? await this.getPrefixContents(bucket, parentPrefix)
                : await this.getBucketContents(bucket);

              // Check again for the prefix
              const found = currentNodes.find(
                (n) => isPrefixNode(n) && n.prefix === currentPrefix
              );
              if (found) {
                if (isLastSegment) {
                  return found;
                }
                // Continue to next level
                currentNodes = await this.getPrefixContents(bucket, currentPrefix);
                break;
              }

              hasMore = currentNodes.some(isLoadMoreNode);
            } else {
              hasMore = false;
            }
          }

          if (!prefixNode) {
            return undefined;
          }
        } else {
          if (isLastSegment) {
            return prefixNode;
          }
          // Get children of this prefix and continue
          currentNodes = await this.getPrefixContents(bucket, currentPrefix);
        }
      }
    }

    return undefined;
  }
}
