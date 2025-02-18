// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

'use strict';

import { ChildProcess } from 'child_process';
import * as os from 'os';
import { Subject } from 'rxjs/Subject';
import * as util from 'util';
import { MessageConnection, NotificationType, RequestType, RequestType0 } from 'vscode-jsonrpc';
import { IPlatformService } from '../../common/platform/types';
import { PythonEnvironment } from '../../pythonEnvironments/info';
import { BaseError } from '../../../platform/errors/types';
import { traceError, traceVerbose, traceWarning } from '../../logging';
import { IDisposable } from '../types';
import { createDeferred, Deferred } from '../utils/async';
import { noop } from '../utils/misc';
import {
    ExecutionResult,
    IPythonExecutionService,
    ObservableExecutionResult,
    Output,
    SpawnOptions,
    StdErrError
} from './types.node';

export type ErrorResponse = { error?: string };
export type ExecResponse = ErrorResponse & { stdout: string; stderr?: string };

/**
 * Error thrown when daemon is closed externally.
 *
 * Cause:
 * Daemon process died or the user closed the daemon.
 *
 * Handled by:
 * Showing a message in the first cell.
 */
export class ConnectionClosedError extends BaseError {
    constructor(message: string) {
        super('daemon', message);
    }
}

/**
 * Error thrown when Daemon fails to respond or execute
 *
 * Cause:
 * Daemon code has a bug in it or some module it is using is handing the Daemon
 *
 * Handled by:
 * Showing a message in the first cell or swallowed if the daemon is already running.
 */
export class DaemonError extends BaseError {
    constructor(message: string) {
        super('daemon', message);
    }
}
/**
 * Daemon is a process that runs in the background and provides methods to run modules or scripts.
 */
export abstract class BasePythonDaemon {
    public get isAlive(): boolean {
        return this.connectionClosedMessage === '';
    }
    protected outputObservable = new Subject<Output<string>>();
    private connectionClosedMessage: string = '';
    protected get closed() {
        return this.connectionClosedDeferred.promise;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly connectionClosedDeferred: Deferred<any>;
    private disposables: IDisposable[] = [];
    private disposed = false;
    constructor(
        protected readonly pythonExecutionService: IPythonExecutionService,
        protected readonly platformService: IPlatformService,
        protected readonly interpreter: PythonEnvironment,
        public readonly proc: ChildProcess,
        public readonly connection: MessageConnection
    ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.connectionClosedDeferred = createDeferred<any>();
        // This promise gets used conditionally, if it doesn't get used, and the promise is rejected,
        // then node logs errors. We don't want that, hence add a dummy error handler.
        this.connectionClosedDeferred.promise.catch(noop);
        this.monitorConnection();
    }
    public dispose() {
        // Make sure that we only dispose once so we are not sending multiple kill signals or notifications
        // This daemon can be held by multiple disposes such as a jupyter server daemon process which can
        // be disposed by both the connection and the main async disposable
        this.connectionClosedMessage = 'Daemon disposed from dispose()';
        if (!this.disposed) {
            try {
                this.disposed = true;

                // Proc.kill uses a 'SIGTERM' signal by default to kill. This was failing to kill the process
                // sometimes on Mac and Linux. Changing this over to a 'SIGKILL' to fully kill the process.
                // Windows closes with a different non-signal message, so keep that the same
                // See kill_kernel message of kernel_launcher_daemon.py for and example of this.
                if (this.platformService.isWindows) {
                    this.proc.kill();
                } else {
                    this.proc.kill('SIGKILL');
                }
            } catch {
                noop();
            }
            this.disposables.forEach((item) => item.dispose());
        }
    }
    public execObservable(args: string[], options: SpawnOptions): ObservableExecutionResult<string> {
        if (this.isAlive && this.canExecFileUsingDaemon(args, options)) {
            try {
                return this.execAsObservable({ fileName: args[0] }, args.slice(1), options);
            } catch (ex) {
                if (ex instanceof DaemonError || ex instanceof ConnectionClosedError) {
                    traceWarning('Falling back to Python Execution Service due to failure in daemon', ex);
                    return this.pythonExecutionService.execObservable(args, options);
                } else {
                    throw ex;
                }
            }
        } else {
            return this.pythonExecutionService.execObservable(args, options);
        }
    }
    public execModuleObservable(
        moduleName: string,
        args: string[],
        options: SpawnOptions
    ): ObservableExecutionResult<string> {
        if (this.isAlive && this.canExecModuleUsingDaemon(moduleName, args, options)) {
            try {
                return this.execAsObservable({ moduleName }, args, options);
            } catch (ex) {
                if (ex instanceof DaemonError || ex instanceof ConnectionClosedError) {
                    traceWarning('Falling back to Python Execution Service due to failure in daemon', ex);
                    return this.pythonExecutionService.execModuleObservable(moduleName, args, options);
                } else {
                    throw ex;
                }
            }
        } else {
            return this.pythonExecutionService.execModuleObservable(moduleName, args, options);
        }
    }
    public async exec(args: string[], options: SpawnOptions): Promise<ExecutionResult<string>> {
        if (this.isAlive && this.canExecFileUsingDaemon(args, options)) {
            try {
                return await this.execFileWithDaemon(args[0], args.slice(1), options);
            } catch (ex) {
                if (ex instanceof DaemonError || ex instanceof ConnectionClosedError) {
                    traceWarning('Falling back to Python Execution Service due to failure in daemon', ex);
                    return this.pythonExecutionService.exec(args, options);
                } else {
                    throw ex;
                }
            }
        } else {
            return this.pythonExecutionService.exec(args, options);
        }
    }
    public async execModule(
        moduleName: string,
        args: string[],
        options: SpawnOptions
    ): Promise<ExecutionResult<string>> {
        if (this.isAlive && this.canExecModuleUsingDaemon(moduleName, args, options)) {
            try {
                return await this.execModuleWithDaemon(moduleName, args, options);
            } catch (ex) {
                if (ex instanceof DaemonError || ex instanceof ConnectionClosedError) {
                    traceWarning('Falling back to Python Execution Service due to failure in daemon', ex);
                    return this.pythonExecutionService.execModule(moduleName, args, options);
                } else {
                    throw ex;
                }
            }
        } else {
            return this.pythonExecutionService.execModule(moduleName, args, options);
        }
    }
    protected canExecFileUsingDaemon(args: string[], options: SpawnOptions): boolean {
        return args[0].toLowerCase().endsWith('.py') && this.areOptionsSupported(options);
    }
    protected canExecModuleUsingDaemon(_moduleName: string, _args: string[], options: SpawnOptions): boolean {
        return this.areOptionsSupported(options);
    }
    protected areOptionsSupported(options: SpawnOptions): boolean {
        const daemonSupportedSpawnOptions: (keyof SpawnOptions)[] = [
            'cwd',
            'env',
            'throwOnStdErr',
            'token',
            'encoding',
            'mergeStdOutErr'
        ];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Object.keys(options).every((item) => daemonSupportedSpawnOptions.indexOf(item as any) >= 0);
    }
    protected sendRequestWithoutArgs<R, E>(type: RequestType0<R, E>): Thenable<R> {
        if (this.isAlive && this.proc && typeof this.proc.exitCode !== 'number') {
            return Promise.race([this.connection.sendRequest(type), this.connectionClosedDeferred.promise]);
        }
        return this.connectionClosedDeferred.promise;
    }
    protected sendRequest<P, R, E>(type: RequestType<P, R, E>, params?: P): Thenable<R> {
        if (!this.isAlive || typeof this.proc.exitCode === 'number') {
            traceError('Daemon is handling a request after death.');
        }
        if (this.isAlive && this.proc && typeof this.proc.exitCode !== 'number') {
            // Throw an error if the connection has been closed.
            return Promise.race([this.connection.sendRequest(type, params), this.connectionClosedDeferred.promise]);
        }
        return this.connectionClosedDeferred.promise;
    }
    protected throwIfRPCConnectionIsDead() {
        if (!this.isAlive) {
            throw new ConnectionClosedError(this.connectionClosedMessage);
        }
    }
    protected execAsObservable(
        moduleOrFile: { moduleName: string } | { fileName: string },
        args: string[],
        options: SpawnOptions
    ): ObservableExecutionResult<string> {
        const subject = new Subject<Output<string>>();
        const start = async () => {
            let response: ExecResponse;
            if ('fileName' in moduleOrFile) {
                const request = new RequestType<
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    { file_name: string; args: string[]; cwd?: string; env?: any },
                    ExecResponse,
                    void
                >('exec_file_observable');
                response = await this.sendRequest(request, {
                    file_name: moduleOrFile.fileName,
                    args,
                    cwd: options.cwd,
                    env: options.env
                });
            } else {
                const request = new RequestType<
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    { module_name: string; args: string[]; cwd?: string; env?: any },
                    ExecResponse,
                    void
                >('exec_module_observable');
                response = await this.sendRequest(request, {
                    module_name: moduleOrFile.moduleName,
                    args,
                    cwd: options.cwd,
                    env: options.env
                });
            }
            // Might not get a response object back, as its observable.
            if (response && response.error) {
                throw new DaemonError(response.error);
            }
        };
        let stdErr = '';
        this.proc.stderr?.on('data', (output: string | Buffer) => (stdErr += output.toString()));
        // Wire up stdout/stderr.
        const subscription = this.outputObservable.subscribe((out) => {
            if (out.source === 'stderr' && options.throwOnStdErr) {
                subject.error(new StdErrError(out.out));
            } else if (out.source === 'stderr' && options.mergeStdOutErr) {
                subject.next({ source: 'stdout', out: out.out });
            } else {
                subject.next(out);
            }
        });
        start()
            .catch((ex) => {
                const errorMsg = `Failed to run ${
                    'fileName' in moduleOrFile ? moduleOrFile.fileName : moduleOrFile.moduleName
                } as observable with args ${args.join(' ')}`;
                traceError(errorMsg, ex);
                subject.next({ source: 'stderr', out: `${errorMsg}\n${stdErr}` });
                subject.error(ex);
            })
            .finally(() => {
                // Wait until all messages are received.
                setTimeout(() => {
                    subscription.unsubscribe();
                    subject.complete();
                }, 100);
            })
            .ignoreErrors();

        return {
            proc: this.proc,
            dispose: () => this.dispose(),
            out: subject
        };
    }
    /**
     * Process the response.
     *
     * @private
     * @param {{ error?: string | undefined; stdout: string; stderr?: string }} response
     * @param {SpawnOptions} options
     * @memberof PythonDaemonExecutionService
     */
    private processResponse(
        response: { error?: string | undefined; stdout: string; stderr?: string },
        options: SpawnOptions
    ) {
        if (response.error) {
            throw new DaemonError(`Failed to execute using the daemon, ${response.error}`);
        }
        // Throw an error if configured to do so if there's any output in stderr.
        if (response.stderr && options.throwOnStdErr) {
            throw new StdErrError(response.stderr);
        }
        // Merge stdout and stderr into on if configured to do so.
        if (response.stderr && options.mergeStdOutErr) {
            response.stdout = `${response.stdout || ''}${os.EOL}${response.stderr}`;
        }
    }
    private async execFileWithDaemon(
        fileName: string,
        args: string[],
        options: SpawnOptions
    ): Promise<ExecutionResult<string>> {
        const request = new RequestType<
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { file_name: string; args: string[]; cwd?: string; env?: any },
            ExecResponse,
            void
        >('exec_file');
        const response = await this.sendRequest(request, {
            file_name: fileName,
            args,
            cwd: options.cwd,
            env: options.env
        });
        this.processResponse(response, options);
        return response;
    }
    private async execModuleWithDaemon(
        moduleName: string,
        args: string[],
        options: SpawnOptions
    ): Promise<ExecutionResult<string>> {
        const request = new RequestType<
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { module_name: string; args: string[]; cwd?: string; env?: any },
            ExecResponse,
            void
        >('exec_module');
        const response = await this.sendRequest(request, {
            module_name: moduleName,
            args,
            cwd: options.cwd,
            env: options.env
        });
        this.processResponse(response, options);
        return response;
    }
    private monitorConnection() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logConnectionStatus = (msg: string, ex?: any) => {
            if (!this.disposed) {
                this.connectionClosedMessage += msg + (ex ? `, With Error: ${util.format(ex)}` : '');
                traceWarning(msg);
                this.connectionClosedDeferred.reject(new ConnectionClosedError(this.connectionClosedMessage));
                if (ex) {
                    traceError('Daemon Connection errored', ex);
                }
            }
        };
        this.disposables.push(this.connection.onClose(() => logConnectionStatus('Daemon Connection Closed')));
        this.disposables.push(this.connection.onDispose(() => logConnectionStatus('Daemon Connection disposed')));
        this.disposables.push(this.connection.onError((ex) => logConnectionStatus('Daemon Connection errored', ex)));
        // this.proc.on('error', error => logConnectionStatus('Daemon Processed died with error', error));
        this.proc.on('exit', (code) => logConnectionStatus('Daemon Processed died with exit code', code));
        // Wire up stdout/stderr.
        const OutputNotification = new NotificationType<Output<string>>('output');
        this.connection.onNotification(OutputNotification, (output) => this.outputObservable.next(output));
        const logNotification = new NotificationType<{
            level: 'WARN' | 'WARNING' | 'INFO' | 'DEBUG' | 'NOTSET';
            msg: string;
            pid?: string;
        }>('log');
        this.connection.onNotification(logNotification, (output) => {
            // Logging from python code will be displayed only if we have verbose logging turned on.
            const pid = output.pid ? ` (pid: ${output.pid})` : '';
            const msg = `Python Daemon${pid}: ${output.msg}`;
            if (output.level === 'DEBUG' || output.level === 'NOTSET') {
                traceVerbose(msg);
            } else if (output.level === 'INFO') {
                traceVerbose(msg);
            } else if (output.level === 'WARN' || output.level === 'WARNING') {
                traceVerbose(msg);
            } else {
                traceError(msg);
            }
        });
        this.connection.onUnhandledNotification((e) => traceError(`Unhandled notification: ${e.method}`));
    }
}
