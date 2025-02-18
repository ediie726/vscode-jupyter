// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import { EventEmitter, Uri } from 'vscode';
import { ServerStatus } from '../../../datascience-ui/interactive-common/mainState';
import { IPythonExtensionChecker } from '../../api/types';
import { IWorkspaceService } from '../../common/application/types';
import { traceWarning } from '../../common/logger';
import { IConfigurationService, IDisposableRegistry, Resource } from '../../common/types';
import { noop } from '../../common/utils/misc';
import { Identifiers, Settings, Telemetry } from '../constants';
import { sendKernelTelemetryWhenDone, trackKernelResourceInformation } from '../telemetry/telemetry';
import {
    ConnectNotebookProviderOptions,
    GetNotebookOptions,
    IJupyterNotebookProvider,
    INotebook,
    INotebookProvider,
    INotebookProviderConnection,
    IRawNotebookProvider
} from '../types';

@injectable()
export class NotebookProvider implements INotebookProvider {
    private readonly notebooks = new Map<string, Promise<INotebook>>();
    private _notebookCreated = new EventEmitter<{ identity: Uri; notebook: INotebook }>();
    private readonly _onSessionStatusChanged = new EventEmitter<{ status: ServerStatus; notebook: INotebook }>();
    private readonly _type: 'jupyter' | 'raw' = 'jupyter';
    public get activeNotebooks() {
        return [...this.notebooks.values()];
    }
    public get onSessionStatusChanged() {
        return this._onSessionStatusChanged.event;
    }
    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IRawNotebookProvider) private readonly rawNotebookProvider: IRawNotebookProvider,
        @inject(IJupyterNotebookProvider) private readonly jupyterNotebookProvider: IJupyterNotebookProvider,
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(IPythonExtensionChecker) private readonly extensionChecker: IPythonExtensionChecker,
        @inject(IConfigurationService) private readonly configService: IConfigurationService
    ) {
        this._type = this.rawNotebookProvider.isSupported ? 'raw' : 'jupyter';
    }
    public get onNotebookCreated() {
        return this._notebookCreated.event;
    }

    public get type(): 'jupyter' | 'raw' {
        return this._type;
    }

    // Attempt to connect to our server provider, and if we do, return the connection info
    public async connect(options: ConnectNotebookProviderOptions): Promise<INotebookProviderConnection | undefined> {
        const settings = this.configService.getSettings(undefined);
        const serverType: string | undefined = settings.jupyterServerType;

        // Connect to either a jupyter server or a stubbed out raw notebook "connection"
        if (this.rawNotebookProvider.isSupported) {
            return this.rawNotebookProvider.connect({
                ...options
            });
        } else if (
            this.extensionChecker.isPythonExtensionInstalled ||
            serverType === Settings.JupyterServerRemoteLaunch
        ) {
            return this.jupyterNotebookProvider.connect({
                ...options
            });
        } else if (!options.getOnly) {
            await this.extensionChecker.showPythonExtensionInstallRequiredPrompt();
        }
    }
    public async disposeAssociatedNotebook(options: { identity: Uri }) {
        const nbPromise = this.notebooks.get(options.identity.toString());
        if (!nbPromise) {
            return;
        }
        this.notebooks.delete(options.identity.toString());
        await nbPromise
            .then((nb) => nb.dispose())
            .catch((ex) => traceWarning('Failed to dispose notebook in disposeAssociatedNotebook', ex));
    }
    public async getOrCreateNotebook(options: GetNotebookOptions): Promise<INotebook | undefined> {
        const rawKernel = this.rawNotebookProvider.isSupported;

        // Check our own promise cache
        if (this.notebooks.get(options.identity.toString())) {
            return this.notebooks.get(options.identity.toString())!!;
        }

        // Check to see if our provider already has this notebook
        const notebook = rawKernel
            ? await this.rawNotebookProvider.getNotebook(options.identity, options.token)
            : await this.jupyterNotebookProvider.getNotebook(options);
        if (notebook && !notebook.disposed) {
            this.cacheNotebookPromise(options.identity, Promise.resolve(notebook));
            return notebook;
        }

        // If get only, don't create a notebook
        if (options.getOnly) {
            return undefined;
        }

        // We want to cache a Promise<INotebook> from the create functions
        // but jupyterNotebookProvider.createNotebook can be undefined if the server is not available
        // so check for our connection here first
        if (!rawKernel) {
            if (!(await this.jupyterNotebookProvider.connect(options))) {
                return undefined;
            }
        }

        // Finally create if needed
        let resource: Resource = options.resource;
        if (options.identity.scheme === Identifiers.HistoryPurpose && !resource) {
            // If we have any workspaces, then use the first available workspace.
            // This is required, else using `undefined` as a resource when we have worksapce folders is a different meaning.
            // This means interactive window doesn't properly support mult-root workspaces as we pick first workspace.
            // Ideally we need to pick the resource of the corresponding Python file.
            resource = this.workspaceService.hasWorkspaceFolders
                ? this.workspaceService.workspaceFolders![0]!.uri
                : undefined;
        }

        trackKernelResourceInformation(resource, { kernelConnection: options.kernelConnection });
        const promise = rawKernel
            ? this.rawNotebookProvider.createNotebook(
                  options.identity,
                  resource,
                  options.disableUI,
                  options.metadata,
                  options.kernelConnection,
                  options.token
              )
            : this.jupyterNotebookProvider.createNotebook(options);

        sendKernelTelemetryWhenDone(resource, Telemetry.NotebookStart, promise, undefined, {
            disableUI: options.disableUI
        });

        this.cacheNotebookPromise(options.identity, promise);

        return promise;
    }

    // Cache the promise that will return a notebook
    private cacheNotebookPromise(identity: Uri, promise: Promise<INotebook>) {
        this.notebooks.set(identity.toString(), promise);

        // Remove promise from cache if the same promise still exists.
        const removeFromCache = () => {
            const cachedPromise = this.notebooks.get(identity.toString());
            if (cachedPromise === promise) {
                this.notebooks.delete(identity.toString());
            }
        };

        promise
            .then((nb) => {
                // If the notebook is disposed, remove from cache.
                nb.onDisposed(removeFromCache);
                nb.onSessionStatusChanged(
                    (e) => this._onSessionStatusChanged.fire({ status: e, notebook: nb }),
                    this,
                    this.disposables
                );
                this._notebookCreated.fire({ identity: identity, notebook: nb });
            })
            .catch(noop);

        // If promise fails, then remove the promise from cache.
        promise.catch(removeFromCache);
    }
}
