/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TelemetryEvent } from '@microsoft/compose-language-service/lib/client/TelemetryEvent';
import { callWithTelemetryAndErrorHandling, createExperimentationService, IActionContext, registerErrorHandler, registerEvent, registerReportIssueCommand, registerUIExtensionVariables, UserCancelledError } from '@microsoft/vscode-azext-utils';
import * as path from 'path';
import * as vscode from 'vscode';
import { window } from 'vscode';
import { ConfigurationParams, DidChangeConfigurationNotification, DocumentSelector, LanguageClient, LanguageClientOptions, Middleware, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import * as tas from 'vscode-tas-client';
import { registerCommands } from './commands/registerCommands';
import { registerDebugProvider } from './debugging/DebugHelper';
import { DockerExtensionApi } from './DockerExtensionApi';
import { DockerfileCompletionItemProvider } from './dockerfileCompletionItemProvider';
import { ext } from './extensionVariables';
import { AutoConfigurableDockerClient } from './runtimes/clients/AutoConfigurableDockerClient';
import { AutoConfigurableDockerComposeClient } from './runtimes/clients/AutoConfigurableDockerComposeClient';
import { ContainerRuntimeManager } from './runtimes/ContainerRuntimeManager';
import { ContainerFilesProvider } from './runtimes/files/ContainerFilesProvider';
import { OrchestratorRuntimeManager } from './runtimes/OrchestratorRuntimeManager';
import { registerTaskProviders } from './tasks/TaskHelper';
import { ActivityMeasurementService } from './telemetry/ActivityMeasurementService';
import { registerListeners } from './telemetry/registerListeners';
import { registerTrees } from './tree/registerTrees';
import { AlternateYamlLanguageServiceClientFeature } from './utils/AlternateYamlLanguageServiceClientFeature';
import { AzExtLogOutputChannelWrapper } from './utils/AzExtLogOutputChannelWrapper';
import { AzureAccountExtensionListener } from './utils/AzureAccountExtensionListener';
import { logDockerEnvironment, logSystemInfo } from './utils/diagnostics';
import { DocumentSettingsClientFeature } from './utils/DocumentSettingsClientFeature';
import { migrateOldEnvironmentSettingsIfNeeded } from './utils/migrateOldEnvironmentSettingsIfNeeded';
import { registerDockerContextStatusBarEvent } from './utils/registerDockerContextStatusBarItems';

export type KeyInfo = { [keyName: string]: string };

export interface ComposeVersionKeys {
    all: KeyInfo;
    v1: KeyInfo;
    v2: KeyInfo;
}

let dockerfileLanguageClient: LanguageClient;
let composeLanguageClient: LanguageClient;
let nativeClient: LanguageClient;

const DOCUMENT_SELECTOR: DocumentSelector = [
    { language: 'dockerfile', scheme: 'file' }
];


function initializeExtensionVariables(ctx: vscode.ExtensionContext): void {
    ext.context = ctx;

    ext.outputChannel = new AzExtLogOutputChannelWrapper(vscode.window.createOutputChannel('Docker', { log: true }), ext.prefix);
    ctx.subscriptions.push(ext.outputChannel);

    registerUIExtensionVariables(ext);
}

export async function activateInternal(ctx: vscode.ExtensionContext, perfStats: { loadStartTime: number, loadEndTime: number | undefined }): Promise<unknown | undefined> {
    perfStats.loadEndTime = Date.now();

    initializeExtensionVariables(ctx);

    await callWithTelemetryAndErrorHandling('docker.activate', async (activateContext: IActionContext) => {
        activateContext.errorHandling.rethrow = true;
        activateContext.telemetry.properties.isActivationEvent = 'true';
        activateContext.telemetry.measurements.mainFileLoad = (perfStats.loadEndTime - perfStats.loadStartTime) / 1000;

        // All of these internally handle telemetry opt-in
        ext.activityMeasurementService = new ActivityMeasurementService(ctx.globalState);
        ext.experimentationService = await createExperimentationService(
            ctx,
            process.env.VSCODE_DOCKER_TEAM === '1' ? tas.TargetPopulation.Team : undefined // If VSCODE_DOCKER_TEAM isn't set, let @microsoft/vscode-azext-utils decide target population
        );

        logSystemInfo(ext.outputChannel);

        // Disabled for now
        // (new SurveyManager()).activate();

        // Remove the "Report Issue" button from all error messages in favor of the command
        // TODO: use built-in issue reporter if/when support is added to include arbitrary info in addition to repro steps (which we would leave blank to force the user to type *something*)
        registerErrorHandler(ctx => ctx.errorHandling.suppressReportIssue = true);
        registerReportIssueCommand('vscode-docker.help.reportIssue');

        // Set up Dockerfile completion provider
        ctx.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(
                DOCUMENT_SELECTOR,
                new DockerfileCompletionItemProvider(),
                '.'
            )
        );

        // Set up environment variables
        registerEnvironmentVariableContributions();

        // Set up runtime managers
        ctx.subscriptions.push(
            ext.runtimeManager = new ContainerRuntimeManager(),
            ext.orchestratorManager = new OrchestratorRuntimeManager()
        );

        // Set up Docker clients
        registerDockerClients();

        // Set up container filesystem provider
        ctx.subscriptions.push(
            vscode.workspace.registerFileSystemProvider(
                'docker',
                new ContainerFilesProvider(),
                {
                    // While Windows containers aren't generally case-sensitive, Linux containers are and make up the overwhelming majority of running containers.
                    isCaseSensitive: true,
                    isReadonly: false,
                }
            )
        );

        registerTrees();
        registerCommands();

        // Set up docker context status bar items
        registerDockerContextStatusBarEvent(ctx);

        registerDebugProvider(ctx);
        registerTaskProviders(ctx);

        if (await discoverDockerLsp()) {
            activateDockerNativeLanguageClient(ctx);
        }
        else {
            activateDockerfileLanguageClient(ctx);
        }

        activateComposeLanguageClient(ctx);

        registerListeners();
    });

    // If this call results in changes to the values, the settings listeners set up below will automatically re-update
    // Don't wait
    void migrateOldEnvironmentSettingsIfNeeded();

    return new DockerExtensionApi(ctx);
}

async function discoverDockerLsp(): Promise<boolean> {
    //const config = vscode.workspace.getConfiguration('docker');
    //const dockerCommand = config.get<string | undefined>('dockerPath') || 'docker';

    try {
	const result = await ext.runWithDefaults(client => client.isLspInstalled());

        if (result) {
	    return true;
        }
    } catch (e) {}

    return false;
}

export async function deactivateInternal(ctx: vscode.ExtensionContext): Promise<void> {
    await callWithTelemetryAndErrorHandling('docker.deactivate', async (activateContext: IActionContext) => {
        activateContext.telemetry.properties.isActivationEvent = 'true';
        AzureAccountExtensionListener.dispose();

        await Promise.all([
            dockerfileLanguageClient.stop(),
            composeLanguageClient.stop(),
	    nativeClient.stop()
        ]);
    });
}

function registerEnvironmentVariableContributions(): void {
    // Set environment variable contributions initially
    setEnvironmentVariableContributions();

    // Register an event to watch for changes to config, reconfigure if needed
    registerEvent('docker.environment.changed', vscode.workspace.onDidChangeConfiguration, (actionContext: IActionContext, e: vscode.ConfigurationChangeEvent) => {
        actionContext.telemetry.suppressAll = true;
        actionContext.errorHandling.suppressDisplay = true;

        if (e.affectsConfiguration('docker.environment')) {
            logDockerEnvironment(ext.outputChannel);
            setEnvironmentVariableContributions();
        }
    });
}

function setEnvironmentVariableContributions(): void {
    const settingValue: NodeJS.ProcessEnv = vscode.workspace.getConfiguration('docker').get<NodeJS.ProcessEnv>('environment', {});

    ext.context.environmentVariableCollection.clear();
    ext.context.environmentVariableCollection.persistent = true;

    for (const key of Object.keys(settingValue)) {
        ext.context.environmentVariableCollection.replace(key, settingValue[key]);
    }
}

function registerDockerClients(): void {
    // Create the clients
    const dockerClient = new AutoConfigurableDockerClient();
    const composeClient = new AutoConfigurableDockerComposeClient();

    // Register the clients
    ext.context.subscriptions.push(
        ext.runtimeManager.registerRuntimeClient(dockerClient),
        ext.orchestratorManager.registerRuntimeClient(composeClient)
    );

    // Register an event to watch for changes to config, reconfigure if needed
    registerEvent('docker.command.changed', vscode.workspace.onDidChangeConfiguration, (actionContext: IActionContext, e: vscode.ConfigurationChangeEvent) => {
        actionContext.telemetry.suppressAll = true;
        actionContext.errorHandling.suppressDisplay = true;

        if (e.affectsConfiguration('docker.dockerPath')) {
            dockerClient.reconfigure();
        }

        if (e.affectsConfiguration('docker.composeCommand')) {
            composeClient.reconfigure();
        }
    });
}

//#region Language services

/* eslint-disable @typescript-eslint/no-namespace */
namespace Configuration {
    export function computeConfiguration(params: ConfigurationParams): vscode.WorkspaceConfiguration[] {
        const result: vscode.WorkspaceConfiguration[] = [];
        for (const item of params.items) {
            let config: vscode.WorkspaceConfiguration;

            if (item.scopeUri) {
                config = vscode.workspace.getConfiguration(
                    item.section,
                    dockerfileLanguageClient.protocol2CodeConverter.asUri(item.scopeUri)
                );
            } else {
                config = vscode.workspace.getConfiguration(item.section);
            }
            result.push(config);
        }
        return result;
    }

    export function initialize(ctx: vscode.ExtensionContext): void {
        ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(
            async (e: vscode.ConfigurationChangeEvent) => {
                // notify the language server that settings have change
                void dockerfileLanguageClient.sendNotification(DidChangeConfigurationNotification.type, {
                    settings: null
                });
            }
        ));
    }
}
/* eslint-enable @typescript-eslint/no-namespace */

function activateDockerNativeLanguageClient(ctx: vscode.ExtensionContext): void {

    void callWithTelemetryAndErrorHandling('docker.nativelanguageclient.activate', async (context: IActionContext) => {

        context.telemetry.properties.isActivationEvent = 'true';

        const config = vscode.workspace.getConfiguration('docker');
        const dockerCommand = config.get<string | undefined>('dockerPath') || 'docker';

        ext.outputChannel.debug(`docker.dockerPath: ${dockerCommand}`);
        const serverModule = `${dockerCommand}`;

        const args = [
             "lsp",
             "listen"
        ];

        const user = vscode.workspace.getConfiguration().get("DockerLsp.User");
        const workspace = vscode.workspace.getConfiguration().get("DockerLsp.Workspace");
        if (!!user && user != "") {
             args.push("--user", user as string);
        }
        if (!!workspace && workspace != "") {
            args.push("--workspace", workspace as string);
        }

        const serverOptions: ServerOptions = {
            run: { command: serverModule, transport: TransportKind.stdio, args },
            debug: {
                command: serverModule,
                args,
                transport: TransportKind.stdio,
            },
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: DOCUMENT_SELECTOR,
            progressOnInitialization: true,
            outputChannel: window.createOutputChannel("Docker LSP"),
            revealOutputChannelOn: 4,
            middleware: {
                didOpen: async (data, next) => {
                    nativeClient.info("Did open: " + JSON.stringify(data));
                    return next(data);
                },
                didChange: async (data, next) => {
                    nativeClient.info("Did change: " + JSON.stringify(data));
                    return next(data);
                }
            }
        };

        nativeClient = new LanguageClient(
            'dockerLanguageClient',
            'Docker LSP Client',
            serverOptions,
            clientOptions
        );
        const command = 'dockerLspClient.serverInfoShow';

        const commandHandler = async () => {
            nativeClient.info("Getting server info");
            await nativeClient.sendRequest("docker/serverInfo/show");
        };

        ctx.subscriptions.push(vscode.commands.registerCommand(command, commandHandler));
        ctx.subscriptions.push(vscode.commands.registerCommand('dockerLspClient.login',
            async () => {
                await nativeClient.sendRequest("docker/login");
            }));

        vscode.workspace.onDidChangeConfiguration(event => {
            nativeClient.info(`configuration change:  ${JSON.stringify(event)}`);
            if (event.affectsConfiguration('DockerLsp.User') || event.affectsConfiguration('DockerLsp.Workspace')) {
                nativeClient.info('update login info')
                nativeClient.sendRequest(
                    "docker/login",
                    vscode.workspace.getConfiguration().get("DockerLsp.User"),
                    vscode.workspace.getConfiguration().get("DockerLsp.Workspace"));
            }
        });

        await nativeClient.start();

        ctx.subscriptions.push(nativeClient);

        nativeClient.info("Client started...");
        const r = await nativeClient.sendRequest("docker/serverInfo/raw");
        nativeClient.info("Log path: " + r['log-path']);
        nativeClient.info("REPL port: " + r['port']);
    });
}

function activateDockerfileLanguageClient(ctx: vscode.ExtensionContext): void {
    // Don't wait
    void callWithTelemetryAndErrorHandling('docker.languageclient.activate', async (context: IActionContext) => {
        context.telemetry.properties.isActivationEvent = 'true';
        const serverModule = ctx.asAbsolutePath(
            path.join(
                "dist",
                "dockerfile-language-server-nodejs",
                "lib",
                "server.js"
            )
        );

        const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

        const serverOptions: ServerOptions = {
            run: {
                module: serverModule,
                transport: TransportKind.ipc,
                args: ["--node-ipc"]
            },
            debug: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: debugOptions
            }
        };

        const middleware: Middleware = {
            workspace: {
                configuration: Configuration.computeConfiguration
            }
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: DOCUMENT_SELECTOR,
            synchronize: {
                fileEvents: vscode.workspace.createFileSystemWatcher("**/.clientrc")
            },
            middleware: middleware
        };

        dockerfileLanguageClient = new LanguageClient(
            "dockerfile-langserver",
            "Dockerfile Language Server",
            serverOptions,
            clientOptions
        );
        dockerfileLanguageClient.registerProposedFeatures();

        ctx.subscriptions.push(dockerfileLanguageClient);
        await dockerfileLanguageClient.start();
        Configuration.initialize(ctx);
    });
}

function activateComposeLanguageClient(ctx: vscode.ExtensionContext): void {
    // Don't wait
    void callWithTelemetryAndErrorHandling('docker.composelanguageclient.activate', async (context: IActionContext) => {
        context.telemetry.properties.isActivationEvent = 'true';

        const config = vscode.workspace.getConfiguration('docker');
        if (!config.get('enableDockerComposeLanguageService', true)) {
            throw new UserCancelledError('languageServiceDisabled');
        }

        const serverModule = ctx.asAbsolutePath(
            path.join(
                "dist",
                "compose-language-service",
                "lib",
                "server.js"
            )
        );

        const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

        const serverOptions: ServerOptions = {
            run: {
                module: serverModule,
                transport: TransportKind.ipc,
                args: ["--node-ipc"]
            },
            debug: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: debugOptions
            }
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ language: 'dockercompose' }]
        };

        composeLanguageClient = new LanguageClient(
            "compose-language-service",
            "Docker Compose Language Server",
            serverOptions,
            clientOptions
        );
        composeLanguageClient.registerProposedFeatures();
        composeLanguageClient.registerFeature(new DocumentSettingsClientFeature(composeLanguageClient));
        composeLanguageClient.registerFeature(new AlternateYamlLanguageServiceClientFeature());

        registerEvent('compose-langserver-event', composeLanguageClient.onTelemetry, (context: IActionContext, evtArgs: TelemetryEvent) => {
            context.telemetry.properties.langServerEventName = evtArgs.eventName;
            context.telemetry.suppressAll = evtArgs.suppressAll;
            context.telemetry.suppressIfSuccessful = evtArgs.suppressIfSuccessful;

            Object.assign(context.telemetry.measurements, evtArgs.measurements);
            Object.assign(context.telemetry.properties, evtArgs.properties);
        });

        ctx.subscriptions.push(composeLanguageClient);
        await composeLanguageClient.start();
    });
}

//#endregion Language services
