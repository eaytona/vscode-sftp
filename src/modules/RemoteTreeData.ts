import * as querystring from 'querystring';
import * as vscode from 'vscode';
import upath from '../core/upath';
import { FileType } from '../core/Fs/FileSystem';
import { getAllConfigs } from './config';
import { getRemotefsFromConfig } from '../helper';
import { COMMAND_REMOTEEXPLORER_SHOWRESOURCE } from '../constants';

type Id = number;

interface ExplorerChild {
  resourceUri: vscode.Uri;
  isDirectory: boolean;
}

export interface ExplorerRoot extends ExplorerChild {
  explorerContext: {
    config: any;
    id: Id;
  };
}

export type ExplorerItem = ExplorerRoot | ExplorerChild;

function dirFisrtSort(fileA: ExplorerItem, fileB: ExplorerItem) {
  if (fileA.isDirectory === fileB.isDirectory) {
    return fileA.resourceUri.path.localeCompare(fileB.resourceUri.path);
  }

  return fileA.isDirectory ? -1 : 1;
}

export class RemoteTreeData
  implements vscode.TreeDataProvider<ExplorerItem>, vscode.TextDocumentContentProvider {
  private _roots: ExplorerRoot[];
  private _rootsMap: Map<Id, ExplorerRoot>;
  private _onDidChangeFolder: vscode.EventEmitter<ExplorerItem> = new vscode.EventEmitter<
    ExplorerItem
  >();
  private _onDidChangeFile: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeTreeData: vscode.Event<ExplorerItem> = this._onDidChangeFolder.event;
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChangeFile.event;

  makeResourceUri({ host, port, path, id }) {
    return vscode.Uri.parse(
      `remote://${host}${port ? `:${port}` : ''}/${path.replace(/^\/+/, '')}?rootId=${id}`
    );
  }

  refresh(item?: ExplorerItem): any {
    // refresh root
    if (!item) {
      this._roots = null;
      this._rootsMap = null;
    }

    if (item.isDirectory) {
      this._onDidChangeFolder.fire(item);
    } else {
      this._onDidChangeFile.fire(item.resourceUri);
    }
  }

  getTreeItem(item: ExplorerItem): vscode.TreeItem {
    return {
      resourceUri: item.resourceUri,
      collapsibleState: item.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : undefined,
      contextValue: item.isDirectory ? 'folder' : 'file',
      command: item.isDirectory
        ? undefined
        : {
            command: COMMAND_REMOTEEXPLORER_SHOWRESOURCE,
            arguments: [item.resourceUri],
            title: 'View Remote Resource',
          },
    };
  }

  async getChildren(item?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!item) {
      return this._getRoots();
    }

    const root = this.findRoot(item.resourceUri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${item.resourceUri}.`);
    }
    const fs = await getRemotefsFromConfig(root.explorerContext.config);
    const fileEntries = await fs.list(item.resourceUri.path);
    const query = querystring.parse(item.resourceUri.query);
    query.t = Date.now();
    return fileEntries
      .map(file => ({
        resourceUri: item.resourceUri.with({ path: file.fspath, query: querystring.stringify(query) }),
        isDirectory: file.type === FileType.Directory,
      }))
      .sort(dirFisrtSort);
  }

  getParent(item: ExplorerChild): ExplorerItem {
    const root = this.findRoot(item.resourceUri);
    if (!root) {
      throw new Error(`Can't find config for remote resource ${item.resourceUri}.`);
    }

    if (item.resourceUri.path === root.resourceUri.path) {
      return null;
    }

    const parentResourceUri = item.resourceUri.with({
      path: upath.dirname(item.resourceUri.path),
    });
    return { resourceUri: parentResourceUri, isDirectory: true };
  }

  findRoot(uri: vscode.Uri): ExplorerRoot {
    if (!this._rootsMap) {
      return null;
    }

    const query = querystring.parse(uri.query);
    return this._rootsMap.get(parseInt(query.rootId, 10));
  }

  provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<string> {
    return new Promise(async (resolve, reject) => {
      const root = this.findRoot(uri);
      if (!root) {
        reject(`Can't find remote for resource ${uri}.`);
      }

      const fs = await getRemotefsFromConfig(root.explorerContext.config);
      const stream = await fs.get(uri.fsPath);
      const arr = [];

      const onData = chunk => {
        arr.push(chunk);
      };

      const onEnd = err => {
        if (err) {
          return reject(err);
        }

        resolve(Buffer.concat(arr).toString());
      };

      stream.on('data', onData);
      stream.on('error', onEnd);
      stream.on('end', onEnd);
    });
  }

  private _getRoots(): ExplorerRoot[] {
    if (this._roots) {
      return this._roots;
    }

    this._roots = [];
    this._rootsMap = new Map();
    getAllConfigs().forEach(config => {
      const id = config.id;
      const item = {
        resourceUri: this.makeResourceUri({
          host: config.host,
          port: config.port,
          path: config.remotePath,
          id,
        }),
        isDirectory: true,
        explorerContext: {
          config,
          id,
        },
      };
      this._roots.push(item);
      this._rootsMap.set(id, item);
    });
    return this._roots;
  }
}

export default RemoteTreeData;