// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import type * as nbformat from '@jupyterlab/nbformat';
import { inject, injectable } from 'inversify';
import * as os from 'os';
import * as path from 'path';
import * as uuid from 'uuid/v4';

import { Uri } from 'vscode';
import { concatMultilineString } from '../../../datascience-ui/common';
import { createCodeCell } from '../../../datascience-ui/common/cellFactory';
import { IApplicationShell, IWorkspaceService } from '../../common/application/types';
import { traceError } from '../../common/logger';
import { IFileSystem, IPlatformService } from '../../common/platform/types';
import { IConfigurationService } from '../../common/types';
import * as localize from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import { CellMatcher } from '../cellMatcher';
import { pruneCell } from '../common';
import { CodeSnippets, defaultNotebookFormat, Identifiers } from '../constants';
import {
    CellState,
    ICell,
    IDataScienceErrorHandler,
    IJupyterExecution,
    INotebookEditorProvider,
    INotebookExporter
} from '../types';

@injectable()
export class JupyterExporter implements INotebookExporter {
    constructor(
        @inject(IJupyterExecution) private jupyterExecution: IJupyterExecution,
        @inject(IWorkspaceService) private workspaceService: IWorkspaceService,
        @inject(IConfigurationService) private configService: IConfigurationService,
        @inject(IFileSystem) private fileSystem: IFileSystem,
        @inject(IPlatformService) private readonly platform: IPlatformService,
        @inject(IApplicationShell) private readonly applicationShell: IApplicationShell,
        @inject(INotebookEditorProvider) protected ipynbProvider: INotebookEditorProvider,
        @inject(IDataScienceErrorHandler) protected errorHandler: IDataScienceErrorHandler
    ) {}

    public dispose() {
        noop();
    }

    public async exportToFile(cells: ICell[], file: string, showOpenPrompt: boolean = true): Promise<void> {
        let directoryChange;
        const settings = this.configService.getSettings();
        if (settings.changeDirOnImportExport) {
            directoryChange = file;
        }

        const notebook = await this.translateToNotebook(cells, directoryChange);

        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const contents = JSON.stringify(notebook);
            await this.fileSystem.writeFile(Uri.file(file), contents);
            if (!showOpenPrompt) {
                return;
            }
            const openQuestion1 = localize.DataScience.exportOpenQuestion1();
            void this.applicationShell
                .showInformationMessage(localize.DataScience.exportDialogComplete().format(file), openQuestion1)
                .then(async (str: string | undefined) => {
                    try {
                        if (str === openQuestion1) {
                            await this.ipynbProvider.open(Uri.file(file));
                        }
                    } catch (e) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        await this.errorHandler.handleError(e as any);
                    }
                });
        } catch (exc) {
            traceError('Error in exporting notebook file');
            void this.applicationShell.showInformationMessage(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                localize.DataScience.exportDialogFailed().format(exc as any)
            );
        }
    }
    public async translateToNotebook(
        cells: ICell[],
        changeDirectory?: string,
        kernelSpec?: nbformat.IKernelspecMetadata
    ): Promise<nbformat.INotebookContent | undefined> {
        // If requested, add in a change directory cell to fix relative paths
        if (changeDirectory && this.configService.getSettings().changeDirOnImportExport) {
            cells = await this.addDirectoryChangeCell(cells, changeDirectory);
        }

        const pythonNumber = await this.extractPythonMainVersion();

        // Use this to build our metadata object
        const metadata = {
            language_info: {
                codemirror_mode: {
                    name: 'ipython',
                    version: pythonNumber
                },
                file_extension: '.py',
                mimetype: 'text/x-python',
                name: 'python',
                nbconvert_exporter: 'python',
                pygments_lexer: `ipython${pythonNumber}`,
                version: pythonNumber
            },
            orig_nbformat: defaultNotebookFormat.major,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            kernelspec: kernelSpec as any
        };

        // Create an object for matching cell definitions
        const matcher = new CellMatcher(this.configService.getSettings());

        // Combine this into a JSON object
        return {
            cells: this.pruneCells(cells, matcher),
            nbformat: defaultNotebookFormat.major,
            nbformat_minor: defaultNotebookFormat.minor,
            metadata: metadata
        };
    }

    // For exporting, put in a cell that will change the working directory back to the workspace directory so relative data paths will load correctly
    private addDirectoryChangeCell = async (cells: ICell[], file: string): Promise<ICell[]> => {
        const changeDirectory = await this.calculateDirectoryChange(file, cells);

        if (changeDirectory) {
            const exportChangeDirectory = CodeSnippets.ChangeDirectory.join(os.EOL).format(
                localize.DataScience.exportChangeDirectoryComment(),
                CodeSnippets.ChangeDirectoryCommentIdentifier,
                changeDirectory
            );

            const cell: ICell = {
                data: createCodeCell(exportChangeDirectory),
                id: uuid(),
                file: Identifiers.EmptyFileName,
                line: 0,
                state: CellState.finished
            };

            return [cell, ...cells];
        } else {
            return cells;
        }
    };

    // When we export we want to our change directory back to the first real file that we saw run from any workspace folder
    private firstWorkspaceFolder = async (cells: ICell[]): Promise<string | undefined> => {
        for (const cell of cells) {
            const filename = cell.file;

            // First check that this is an absolute file that exists (we add in temp files to run system cell)
            if (path.isAbsolute(filename) && (await this.fileSystem.localFileExists(filename))) {
                // We've already check that workspace folders above
                for (const folder of this.workspaceService.workspaceFolders!) {
                    if (filename.toLowerCase().startsWith(folder.uri.fsPath.toLowerCase())) {
                        return folder.uri.fsPath;
                    }
                }
            }
        }

        return undefined;
    };

    private calculateDirectoryChange = async (notebookFile: string, cells: ICell[]): Promise<string | undefined> => {
        // Make sure we don't already have a cell with a ChangeDirectory comment in it.
        let directoryChange: string | undefined;
        const haveChangeAlready = cells.find((c) =>
            concatMultilineString(c.data.source).includes(CodeSnippets.ChangeDirectoryCommentIdentifier)
        );
        if (!haveChangeAlready) {
            const notebookFilePath = path.dirname(notebookFile);
            // First see if we have a workspace open, this only works if we have a workspace root to be relative to
            if (this.workspaceService.hasWorkspaceFolders) {
                const workspacePath = await this.firstWorkspaceFolder(cells);

                // Make sure that we have everything that we need here
                if (
                    workspacePath &&
                    path.isAbsolute(workspacePath) &&
                    notebookFilePath &&
                    path.isAbsolute(notebookFilePath)
                ) {
                    directoryChange = path.relative(notebookFilePath, workspacePath);
                }
            }
        }

        // If path.relative can't calculate a relative path, then it just returns the full second path
        // so check here, we only want this if we were able to calculate a relative path, no network shares or drives
        if (directoryChange && !path.isAbsolute(directoryChange)) {
            // Escape windows path chars so they end up in the source escaped
            if (this.platform.isWindows) {
                directoryChange = directoryChange.replace('\\', '\\\\');
            }

            return directoryChange;
        } else {
            return undefined;
        }
    };

    private pruneCells = (cells: ICell[], cellMatcher: CellMatcher): nbformat.IBaseCell[] => {
        // First filter out sys info cells. Jupyter doesn't understand these
        const filtered = cells.filter((c) => c.data.cell_type !== 'messages');

        // Then prune each cell down to just the cell data.
        return filtered.map((c) => this.pruneCell(c, cellMatcher));
    };

    private pruneCell = (cell: ICell, cellMatcher: CellMatcher): nbformat.IBaseCell => {
        // Prune with the common pruning function first.
        const copy = pruneCell({ ...cell.data });

        // Remove the #%% of the top of the source if there is any. We don't need
        // this to end up in the exported ipynb file.
        copy.source = this.pruneSource(cell.data.source, cellMatcher);
        return copy;
    };

    private pruneSource = (source: nbformat.MultilineString, cellMatcher: CellMatcher): nbformat.MultilineString => {
        // Remove the comments on the top if there.
        if (Array.isArray(source) && source.length > 0) {
            if (cellMatcher.isCell(source[0])) {
                return source.slice(1);
            }
        } else {
            const array = source
                .toString()
                .split('\n')
                .map((s) => `${s}\n`);
            if (array.length > 0 && cellMatcher.isCell(array[0])) {
                return array.slice(1);
            }
        }

        return source;
    };

    private extractPythonMainVersion = async (): Promise<number> => {
        // Use the active interpreter
        const usableInterpreter = await this.jupyterExecution.getUsableJupyterPython();
        return usableInterpreter && usableInterpreter.version ? usableInterpreter.version.major : 3;
    };
}
