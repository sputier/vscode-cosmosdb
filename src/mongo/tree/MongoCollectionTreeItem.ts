/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as vm from 'vm';
import * as path from 'path';
import * as _ from 'underscore';
import * as util from '../../utils/vscodeUtils';
import { Collection, Cursor, ObjectID, InsertOneWriteOpResult, BulkWriteOpResultObject } from 'mongodb';
import { IAzureParentTreeItem, IAzureTreeItem, IAzureNode, UserCancelledError } from 'vscode-azureextensionui';
import { DialogBoxResponses, DefaultBatchSize } from '../../constants';
import { IMongoDocument, MongoDocumentTreeItem } from './MongoDocumentTreeItem';

export class MongoCollectionTreeItem implements IAzureParentTreeItem {
	public static contextValue: string = "MongoCollection";
	public readonly contextValue: string = MongoCollectionTreeItem.contextValue;
	public readonly childTypeLabel: string = "Document";

	private readonly collection: Collection;
	private readonly _query: object | undefined;
	private _cursor: Cursor | undefined;
	private _hasMoreChildren: boolean = true;
	private _batchSize: number = DefaultBatchSize;

	constructor(collection: Collection, query?: string) {
		this.collection = collection;
		this._query = query ? JSON.parse(query) : undefined;
	}

	public async update(documents: IMongoDocument[]): Promise<IMongoDocument[]> {
		const operations = documents.map((document) => {
			return {
				updateOne: {
					filter: { _id: new ObjectID(document._id) },
					update: _.omit(document, '_id'),
					upsert: false
				}
			};
		});

		const result: BulkWriteOpResultObject = await this.collection.bulkWrite(operations);
		const output = util.getOutputChannel();
		output.appendLine(`Successfully updated ${result.modifiedCount} document(s), inserted ${result.insertedCount} document(s)`);
		return documents;
	}

	public get id(): string {
		return this.collection.collectionName;
	}

	public get label(): string {
		return this.collection.collectionName;
	}

	public get iconPath(): string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } {
		return {
			light: path.join(__filename, '..', '..', '..', '..', '..', 'resources', 'icons', 'theme-agnostic', 'Collection.svg'),
			dark: path.join(__filename, '..', '..', '..', '..', '..', 'resources', 'icons', 'theme-agnostic', 'Collection.svg'),
		};
	}

	public hasMoreChildren(): boolean {
		return this._hasMoreChildren;
	}

	public async loadMoreChildren(_node: IAzureNode, clearCache: boolean): Promise<IAzureTreeItem[]> {
		if (clearCache || this._cursor === undefined) {
			this._cursor = this.collection.find(this._query).batchSize(DefaultBatchSize);
			this._batchSize = DefaultBatchSize;
		}

		const documents: IMongoDocument[] = [];
		let count: number = 0;
		while (count < this._batchSize) {
			this._hasMoreChildren = await this._cursor.hasNext();
			if (this._hasMoreChildren) {
				documents.push(<IMongoDocument>await this._cursor.next());
				count += 1;
			} else {
				break;
			}
		}
		this._batchSize *= 2;

		return documents.map((document: IMongoDocument) => new MongoDocumentTreeItem(document, this.collection));
	}

	public async createChild(_node: IAzureNode, showCreatingNode: (label: string) => void): Promise<IAzureTreeItem> {
		let docId: string | undefined = await vscode.window.showInputBox({
			placeHolder: "Document ID",
			prompt: "Enter a unique document ID or leave blank for a generated ID",
			ignoreFocusOut: true
		});

		if (docId !== undefined) {
			showCreatingNode(docId);
			const result: InsertOneWriteOpResult = await this.collection.insertOne(docId === '' ? {} : { "id": docId });
			const newDocument: IMongoDocument = await this.collection.findOne({ _id: result.insertedId });
			return new MongoDocumentTreeItem(newDocument, this.collection);
		}

		throw new UserCancelledError();
	}

	executeCommand(name: string, args?: string): Thenable<string> {
		try {
			if (name === 'drop') {
				return reportProgress(this.drop(), 'Dropping collection');
			}
			if (name === 'insertMany') {
				return reportProgress(this.insertMany(args ? parseJSContent(args) : undefined), 'Inserting documents');
			}
			if (name === 'insert') {
				return reportProgress(this.insert(args ? parseJSContent(args) : undefined), 'Inserting document');
			}
			if (name === 'insertOne') {
				return reportProgress(this.insertOne(args ? parseJSContent(args) : undefined), 'Inserting document');
			}
			if (name === 'deleteOne') {
				return reportProgress(this.deleteOne(args ? parseJSContent(args) : undefined), 'Deleting document');
			}
			if (name === 'deleteMany') {
				return reportProgress(this.deleteMany(args ? parseJSContent(args) : undefined), 'Deleting documents');
			}
			if (name === 'remove') {
				return reportProgress(this.remove(args ? parseJSContent(args) : undefined), 'Removing');
			}
			if (name === 'count') {
				return reportProgress(this.count(args ? parseJSContent(args) : undefined), 'Counting');
			}
			if (name === 'findOne') {
				return reportProgress(this.findOne(args ? parseJSContent(args) : undefined), 'Finding');
			}
			return null;
		} catch (error) {
			return Promise.resolve(error);
		}
	}

	public async deleteTreeItem(_node: IAzureNode): Promise<void> {
		const message: string = `Are you sure you want to delete collection '${this.label}'?`;
		const result = await vscode.window.showWarningMessage(message, DialogBoxResponses.Yes, DialogBoxResponses.Cancel);
		if (result === DialogBoxResponses.Yes) {
			await this.drop();
		} else {
			throw new UserCancelledError();
		}
	}

	private async drop(): Promise<string> {
		await this.collection.drop();
		return `Dropped collection '${this.collection.collectionName}'.`;
	}

	private async findOne(args?: Object): Promise<string> {
		const result = await this.collection.findOne(args);
		return this.stringify(result);
	}

	private insert(document: Object): Thenable<string> {
		return this.collection.insert(document)
			.then(({ insertedCount, insertedId, result }) => {
				return this.stringify({ insertedCount, insertedId, result })
			});
	}

	private insertOne(document: Object): Thenable<string> {
		return this.collection.insertOne(document)
			.then(({ insertedCount, insertedId, result }) => {
				return this.stringify({ insertedCount, insertedId, result })
			});
	}

	private insertMany(documents: Object[]): Thenable<string> {
		return this.collection.insertMany(documents)
			.then(({ insertedCount, insertedIds, result }) => {
				return this.stringify({ insertedCount, insertedIds, result })
			});
	}

	private remove(args?: Object): Thenable<string> {
		return this.collection.remove(args)
			.then(({ ops, result }) => {
				return this.stringify({ ops, result })
			});
	}

	private deleteOne(args?: Object): Thenable<string> {
		return this.collection.deleteOne(args)
			.then(({ deletedCount, result }) => {
				return this.stringify({ deletedCount, result })
			});
	}

	private deleteMany(args?: Object): Thenable<string> {
		return this.collection.deleteMany(args)
			.then(({ deletedCount, result }) => {
				return this.stringify({ deletedCount, result })
			});
	}

	private async count(args?: Object): Promise<string> {
		const count = await this.collection.count(args);
		return JSON.stringify(count);
	}

	// tslint:disable-next-line:no-any
	private stringify(result: any): string {
		return JSON.stringify(result, null, '\t')
	}
}

function reportProgress<T>(promise: Thenable<T>, title: string): Thenable<T> {
	return vscode.window.withProgress<T>(
		{
			location: vscode.ProgressLocation.Window,
			title
		},
		(progress) => {
			return promise;
		})
}

// tslint:disable-next-line:no-any
function parseJSContent(content: string): any {
	try {
		const sandbox = {};
		// tslint:disable-next-line:insecure-random
		const key = 'parse' + Math.floor(Math.random() * 1000000);
		sandbox[key] = {};
		vm.runInNewContext(key + '=' + content, sandbox);
		return sandbox[key];
	} catch (error) {
		throw error.message;
	}
}
