/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fse from 'fs-extra';
import * as os from 'os'
import * as path from 'path';
import * as vscode from 'vscode';
import { DialogBoxResponses } from './constants';
import { UserCancelledError, AzureTreeDataProvider, IAzureParentNode, IAzureNode, IActionContext } from 'vscode-azureextensionui';
import * as util from './utils/vscodeUtils';
import { MessageItem } from 'vscode';
import { DocDBDocumentTreeItem } from './docdb/tree/DocDBDocumentTreeItem';
import { DocDBDocumentNodeEditor } from './docdb/editors/DocDBDocumentNodeEditor';
import { MongoDocumentTreeItem } from './mongo/tree/MongoDocumentTreeItem';
import { MongoDocumentNodeEditor } from './mongo/editors/MongoDocumentNodeEditor';
import { MongoCollectionTreeItem } from './mongo/tree/MongoCollectionTreeItem';
import { MongoCollectionNodeEditor } from './mongo/editors/MongoCollectionNodeEditor';

export interface ICosmosEditor<T = {}> {
    label: string;
    id: string;
    getData(): Promise<T>;
    update(data: T): Promise<T>;
}

export class CosmosEditorManager {
    private fileMap: { [key: string]: ICosmosEditor } = {};
    private ignoreSave: boolean = false;

    private readonly showSavePromptKey: string = 'cosmosDB.showSavePrompt';
    private _globalState: vscode.Memento;
    private readonly _persistedEditorsKey: string = "ms-azuretools.vscode-cosmosdb.editors";

    constructor(globalState: vscode.Memento) {
        this._globalState = globalState;
    }

    public async showDocument(editor: ICosmosEditor, fileName: string): Promise<void> {
        const localDocPath = path.join(os.tmpdir(), 'vscode-cosmosdb-editor', fileName);
        await fse.ensureFile(localDocPath);

        const document = await vscode.workspace.openTextDocument(localDocPath);
        if (document.isDirty) {
            const overwriteFlag = await vscode.window.showWarningMessage(`You are about to overwrite "${fileName}", which has unsaved changes. Do you want to continue?`, DialogBoxResponses.Yes, DialogBoxResponses.Cancel);
            if (overwriteFlag !== DialogBoxResponses.Yes) {
                throw new UserCancelledError();
            }
        }
        this.fileMap[localDocPath] = editor;
        const fileMapLabels = this._globalState.get(this._persistedEditorsKey, {});
        Object.keys(this.fileMap).forEach((key) => fileMapLabels[key] = (this.fileMap[key]).id);
        this._globalState.update(this._persistedEditorsKey, fileMapLabels);
        const textEditor = await vscode.window.showTextDocument(document);
        const data = await editor.getData();
        await this.updateEditor(data, textEditor);
    }

    public async updateMatchingNode(documentUri: vscode.Uri, tree?: AzureTreeDataProvider): Promise<void> {
        let filePath: string = Object.keys(this.fileMap).find((filePath) => path.relative(documentUri.fsPath, filePath) === '');
        if (!filePath) {
            filePath = await this.loadPersistedEditor(documentUri, tree);
        }
        const document = await vscode.workspace.openTextDocument(documentUri.fsPath);
        await this.updateToCloud(this.fileMap[filePath], document);
    }

    private async updateToCloud(editor: ICosmosEditor, doc: vscode.TextDocument): Promise<void> {
        const updatedDoc: {} = await editor.update(JSON.parse(doc.getText()));
        const output = util.getOutputChannel();
        const timestamp = (new Date()).toLocaleTimeString();
        output.appendLine(`${timestamp}: Updated entity "${editor.label}"`);
        output.show();
        await this.updateEditor(updatedDoc, vscode.window.activeTextEditor);
    }

    private async updateEditor(data: {}, textEditor: vscode.TextEditor): Promise<void> {
        await util.writeToEditor(textEditor, JSON.stringify(data, null, 2));
        this.ignoreSave = true;
        try {
            await textEditor.document.save();
        } finally {
            this.ignoreSave = false;
        }
    }

    private async loadPersistedEditor(documentUri: vscode.Uri, tree: AzureTreeDataProvider): Promise<string> {
        const persistedEditors = this._globalState.get(this._persistedEditorsKey);
        //Based on the documentUri, split just the appropriate key's value on '/'
        if (persistedEditors) {
            const editorFilePath = Object.keys(persistedEditors).find((label) => path.relative(documentUri.fsPath, label) === '');
            if (editorFilePath) {
                const editorNode: IAzureNode | undefined = await tree.findNode(persistedEditors[editorFilePath]);
                let editor: ICosmosEditor;
                if (editorNode) {
                    if (editorNode.treeItem instanceof MongoCollectionTreeItem) {
                        editor = new MongoCollectionNodeEditor(<IAzureParentNode<MongoCollectionTreeItem>>editorNode);
                    } else if (editorNode.treeItem instanceof DocDBDocumentTreeItem) {
                        editor = new DocDBDocumentNodeEditor(<IAzureNode<DocDBDocumentTreeItem>>editorNode);
                    } else if (editorNode.treeItem instanceof MongoDocumentTreeItem) {
                        editor = new MongoDocumentNodeEditor(<IAzureNode<MongoDocumentTreeItem>>editorNode);
                    }
                    this.fileMap[editorFilePath] = editor;
                } else {
                    throw new Error("Failed to find entity on the tree. Please check the explorer to confirm that the entity exists, and that permissions are intact.");
                }
            }
            return editorFilePath;
        } else {
            return undefined;
        }
    }

    public async onDidSaveTextDocument(context: IActionContext, globalState: vscode.Memento, doc: vscode.TextDocument, tree: AzureTreeDataProvider): Promise<void> {
        context.suppressTelemetry = true;
        let filePath = Object.keys(this.fileMap).find((filePath) => path.relative(doc.uri.fsPath, filePath) === '');
        if (!filePath) {
            filePath = await this.loadPersistedEditor(doc.uri, tree);
        }
        if (!this.ignoreSave && filePath) {
            context.suppressTelemetry = false;
            const editor: ICosmosEditor = this.fileMap[filePath];
            const showSaveWarning: boolean | undefined = vscode.workspace.getConfiguration().get(this.showSavePromptKey);
            if (showSaveWarning !== false) {
                const message: string = `Saving 'cosmos-editor.json' will update the entity "${editor.label}" to the Cloud.`;
                const result: MessageItem | undefined = await vscode.window.showWarningMessage(message, DialogBoxResponses.upload, DialogBoxResponses.uploadDontWarn, DialogBoxResponses.Cancel);

                if (result === DialogBoxResponses.uploadDontWarn) {
                    await vscode.workspace.getConfiguration().update(this.showSavePromptKey, false, vscode.ConfigurationTarget.Global);
                } else if (result !== DialogBoxResponses.upload) {
                    throw new UserCancelledError();
                }
            }

            await this.updateToCloud(editor, doc);
        }
    }

}
