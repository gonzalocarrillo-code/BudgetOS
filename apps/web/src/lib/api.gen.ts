/* Generated from apps/api/openapi.json by scripts/generate-api.mts. Do not edit. */
export interface paths {
    "/api/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/roles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listRoleAssignments"];
        put?: never;
        post: operations["assignRole"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/roles/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["revokeRole"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/envelopes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createEnvelope"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getEnvelope"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateEnvelope"];
        trace?: never;
    };
    "/api/v1/envelopes/{id}/timeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getEnvelopeTimeline"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listEnvelopeVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["createDraftVersion"];
        trace?: never;
    };
    "/api/v1/envelopes/{id}/phasing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateEnvelopePhasing"];
        trace?: never;
    };
    "/api/v1/envelopes/{id}/restore/{versionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["restoreEnvelopeVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/move": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["moveEnvelope"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/split": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["splitEnvelope"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["mergeEnvelopes"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/bulk": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["previewBulkEdit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/bulk/{previewId}/commit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["commitBulkEdit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/envelopes/csv-export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["exportEnvelopesCsv"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/envelopes/csv-import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["importEnvelopesCsv"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submitEnvelopeVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/withdraw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["withdrawEnvelopeRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listApprovals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/approvals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getApproval"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/approvals/{id}/decisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["decideApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/approvals/{id}/external-evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["recordExternalEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/approvals/{id}/withdraw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["withdrawApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/policies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listPolicies"];
        put?: never;
        post: operations["createPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/policies/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updatePolicy"];
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/groups/sync": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["syncGroups"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/dimensions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listDimensions"];
        put?: never;
        post: operations["createDimension"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/dimensions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateDimension"];
        trace?: never;
    };
    "/api/v1/dimensions/{id}/values": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["addDimensionValues"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/values/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateDimensionValue"];
        trace?: never;
    };
    "/api/v1/values/{id}/merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["mergeDimensionValues"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/hierarchy-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listHierarchyTemplates"];
        put?: never;
        post: operations["saveHierarchyTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listMetrics"];
        put?: never;
        post: operations["createMetric"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/targets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listTargets"];
        put?: never;
        post: operations["createTarget"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/targets/{id}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["createTargetDraft"];
        trace?: never;
    };
    "/api/v1/targets/{id}/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submitTarget"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/targets/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listTargetVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/targets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getEnvelopeTargets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listSources"];
        put?: never;
        post: operations["createSource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sources/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateSource"];
        trace?: never;
    };
    "/api/v1/sources/{id}/suggest-mapping": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["suggestSourceMapping"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sources/{id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["runSource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sources/{id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listSourceRuns"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/unmatched-spend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listUnmatchedSpend"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/unmatched-spend/map": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["mapUnmatchedSpend"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/closures": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listClosures"];
        put?: never;
        post: operations["closePeriod"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/closures/{id}/restate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["restateClosure"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/closures/{id}/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getClosureReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["createExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/exports/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getExport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/pacing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getPacing"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/rules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listRules"];
        put?: never;
        post: operations["createRule"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rules/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateRule"];
        trace?: never;
    };
    "/api/v1/alerts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAlerts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/alerts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateAlert"];
        trace?: never;
    };
    "/api/v1/threads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listThreads"];
        put?: never;
        post: operations["createThread"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/threads/{id}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["addComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/comments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteComment"];
        options?: never;
        head?: never;
        patch: operations["editComment"];
        trace?: never;
    };
    "/api/v1/threads/{id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["resolveThread"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/threads/{id}/reopen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reopenThread"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["setSubscription"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listTags"];
        put?: never;
        post: operations["createTag"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tags/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateTag"];
        trace?: never;
    };
    "/api/v1/tags/apply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["applyTag"];
        delete: operations["removeTag"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["search"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/search/suggest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["searchSuggest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["uploadIconAsset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Caller, roles per workspace and permissions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listRoleAssignments: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Role assignments in the workspace */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    assignRole: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    principalType: "user" | "group";
                    /** Format: uuid */
                    principalId: string;
                    /** @enum {string} */
                    role: "VIEWER" | "PLANNER" | "BUDGET_OWNER" | "APPROVER" | "FINANCE" | "DATA_ADMIN" | "WORKSPACE_ADMIN";
                    /** @default {} */
                    scope?: {
                        /** @enum {string} */
                        logic: "and" | "or";
                        not?: boolean;
                        children: ({
                            field: {
                                /** @enum {string} */
                                kind: "dimension";
                                key: string;
                            };
                            /** @enum {string} */
                            op: "eq" | "in" | "descends_from";
                            value: string | string[];
                        } | unknown)[];
                    } | Record<string, never>;
                };
            };
        };
        responses: {
            /** @description Created role assignment */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    revokeRole: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked role assignment */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createEnvelope: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    /**
                     * Format: uuid
                     * @default null
                     */
                    parentId?: string | null;
                    dimensionValues: {
                        [key: string]: string;
                    };
                    startDate: string;
                    endDate: string;
                    currency: string;
                    /**
                     * Format: uuid
                     * @default null
                     */
                    ownerId?: string | null;
                    /**
                     * Format: uuid
                     * @default null
                     */
                    periodId?: string | null;
                    amount?: string;
                    phasing?: {
                        month: string;
                        amount: string;
                    }[];
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description Created envelope (with v1 draft when an amount is given) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getEnvelope: {
        parameters: {
            query?: {
                /** @description YYYY-MM-DD (end of day UTC) or ISO datetime: adds the budget approved at that instant */
                as_of?: string;
            };
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Envelope with its approved version, open draft and, with as_of, the approved version at that instant */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateEnvelope: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    rowVersion: number;
                    name?: string;
                    /** Format: uuid */
                    ownerId?: string | null;
                    startDate?: string;
                    endDate?: string;
                    /** Format: uuid */
                    periodId?: string | null;
                };
            };
        };
        responses: {
            /** @description Updated envelope metadata */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Stale rowVersion; details carry currentRowVersion and currentVersionId */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getEnvelopeTimeline: {
        parameters: {
            query?: {
                /** @description Roll-up timeline of the whole subtree */
                descendants?: boolean;
                limit?: number;
                cursor?: string;
            };
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Decision timeline, newest first: { rows: [{ at, kind, title, actor, detail, refs }], nextCursor } */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listEnvelopeVersions: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description All versions, newest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createDraftVersion: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    amount: string;
                    rationale?: string;
                    phasing?: {
                        month: string;
                        amount: string;
                    }[];
                    /** Format: uuid */
                    basedOnVersionId: string | null;
                    /** @default [] */
                    attachments?: {
                        gcsUri: string;
                        name: string;
                        sha256: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description New draft version */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Stale basedOnVersionId; details.currentVersionId */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Period closed */
            423: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateEnvelopePhasing: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    phasing: {
                        month: string;
                        amount: string;
                    }[];
                    /** Format: uuid */
                    basedOnVersionId: string;
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description New draft version with the same amount and new phasing */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    restoreEnvelopeVersion: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
                versionId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    basedOnVersionId: string | null;
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description New draft version copied from the given version */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    moveEnvelope: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    parentId: string | null;
                    rowVersion: number;
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description Moved; lineage written; an open request re-routed if its policy changed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Stale rowVersion */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description CAP_EXCEEDED under the new parent, or a cycle */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    splitEnvelope: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    basedOnVersionId: string;
                    rationale: string;
                    parts: {
                        name: string;
                        amount: string;
                        /** @default {} */
                        dimensionValues?: {
                            [key: string]: string;
                        };
                    }[];
                };
            };
        };
        responses: {
            /** @description New siblings with drafts summing to the approved amount; one approval (or auto-approved); source archived once approved */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    mergeEnvelopes: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    sourceIds: string[];
                    name: string;
                    dimensionValues: {
                        [key: string]: string;
                    };
                    rationale: string;
                };
            };
        };
        responses: {
            /** @description New sibling holding the sources' approved total; one approval (or auto-approved); sources archived once approved */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    previewBulkEdit: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    workspaceId: string;
                    selection: {
                        envelopeIds: string[];
                    } | {
                        filter: {
                            /** @enum {string} */
                            logic: "and" | "or";
                            not?: boolean;
                            children: ({
                                field: {
                                    /** @enum {string} */
                                    kind: "dimension";
                                    key: string;
                                } | {
                                    /** @enum {string} */
                                    kind: "measure";
                                    /** @enum {string} */
                                    key: "budget" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct";
                                } | {
                                    /** @enum {string} */
                                    kind: "target";
                                    metric: string;
                                    /** @enum {string} */
                                    field: "value" | "actual" | "vs_target_pct" | "exists";
                                } | {
                                    /** @enum {string} */
                                    kind: "attr";
                                    /** @enum {string} */
                                    key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf";
                                };
                                /** @enum {string} */
                                op: "eq" | "neq" | "in" | "nin" | "contains" | "starts_with" | "is_empty" | "not_empty" | "between" | "gt" | "gte" | "lt" | "lte" | "descends_from" | "within";
                                value?: string | number | boolean | (string | number)[] | ((string | number) | (string | number))[] | {
                                    /** @enum {string} */
                                    unit: "day" | "week" | "month" | "quarter" | "year";
                                    amount: number;
                                    /**
                                     * @default today
                                     * @enum {string}
                                     */
                                    anchor?: "today" | "period_start" | "period_end";
                                } | unknown;
                            } | unknown)[];
                        };
                    };
                    operation: {
                        /** @enum {string} */
                        op: "set";
                        amount: string;
                    } | {
                        /** @enum {string} */
                        op: "add";
                        amount: string;
                    } | {
                        /** @enum {string} */
                        op: "pct";
                        pct: number;
                    } | {
                        /** @enum {string} */
                        op: "redistribute";
                        /** Format: uuid */
                        parentId: string;
                        /** @enum {string} */
                        method: "proportional" | "even" | "by_last_actuals" | "by_weights";
                        weights?: {
                            [key: string]: number;
                        };
                        total?: string;
                    } | {
                        /** @enum {string} */
                        op: "copy_previous_period";
                        /** @default 1 */
                        factor?: number;
                    } | {
                        /** @enum {string} */
                        op: "scale_to_total";
                        total: string;
                    } | {
                        /** @enum {string} */
                        op: "paste";
                        rows: {
                            /** Format: uuid */
                            envelopeId: string;
                            amount: string;
                        }[];
                    };
                    rationale: string;
                };
            };
        };
        responses: {
            /** @description BulkPreview: before/after/delta per row, totals, cap violations, policy preview; kept 30 min */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    commitBulkEdit: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                previewId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One draft per row, one bulk_change, one approval request (or auto-approved) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Preview expired */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Rows changed since the preview */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    exportEnvelopesCsv: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    selection: {
                        envelopeIds: string[];
                    } | {
                        filter: {
                            /** @enum {string} */
                            logic: "and" | "or";
                            not?: boolean;
                            children: ({
                                field: {
                                    /** @enum {string} */
                                    kind: "dimension";
                                    key: string;
                                } | {
                                    /** @enum {string} */
                                    kind: "measure";
                                    /** @enum {string} */
                                    key: "budget" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct";
                                } | {
                                    /** @enum {string} */
                                    kind: "target";
                                    metric: string;
                                    /** @enum {string} */
                                    field: "value" | "actual" | "vs_target_pct" | "exists";
                                } | {
                                    /** @enum {string} */
                                    kind: "attr";
                                    /** @enum {string} */
                                    key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf";
                                };
                                /** @enum {string} */
                                op: "eq" | "neq" | "in" | "nin" | "contains" | "starts_with" | "is_empty" | "not_empty" | "between" | "gt" | "gte" | "lt" | "lte" | "descends_from" | "within";
                                value?: string | number | boolean | (string | number)[] | ((string | number) | (string | number))[] | {
                                    /** @enum {string} */
                                    unit: "day" | "week" | "month" | "quarter" | "year";
                                    amount: number;
                                    /**
                                     * @default today
                                     * @enum {string}
                                     */
                                    anchor?: "today" | "period_start" | "period_end";
                                } | unknown;
                            } | unknown)[];
                        };
                    };
                };
            };
        };
        responses: {
            /** @description text/csv: envelope_id, path, currency, approved_amount, amount */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    importEnvelopesCsv: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    csv: string;
                    rationale: string;
                };
            };
        };
        responses: {
            /** @description CsvImportReport: line errors plus a paste preview of the valid rows */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    submitEnvelopeVersion: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    versionId: string;
                };
            };
        };
        responses: {
            /** @description Approval request created, or auto-approved by policy */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not the open draft, request already open, or blocking threads */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description POLICY_NOT_FOUND */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    withdrawEnvelopeRequest: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    comment?: string;
                };
            };
        };
        responses: {
            /** @description Open request withdrawn */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listApprovals: {
        parameters: {
            query?: {
                /** @description Comma-separated RequestStatus; default PENDING,ESCALATED */
                status?: string;
                assignee?: "me";
                limit?: number;
                cursor?: string;
            };
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Inbox page: { rows, nextCursor } */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getApproval: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request with frozen policy, diff and decisions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    decideApproval: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    decision: "approve" | "reject" | "request_changes";
                    comment?: string;
                    /**
                     * @default app
                     * @enum {string}
                     */
                    channel?: "app" | "slack" | "email";
                };
            };
        };
        responses: {
            /** @description Request after the decision */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not an eligible approver for the current step */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description CAP_EXCEEDED on final approval */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    recordExternalEvidence: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    gcsUri: string;
                    sha256: string;
                    approverName: string;
                    approvedOn: string;
                    comment?: string;
                };
            };
        };
        responses: {
            /** @description Evidence recorded; counts toward the step when the policy allows it */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    withdrawApproval: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    comment?: string;
                };
            };
        };
        responses: {
            /** @description Request withdrawn */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listPolicies: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Approval policies by priority */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    priority: number;
                    conditions: {
                        /** @enum {string} */
                        entityType?: "envelope_version" | "target_version" | "bulk_change";
                        amountAbs?: {
                            gte?: number;
                            lt?: number;
                        };
                        deltaAbs?: {
                            gte?: number;
                            lt?: number;
                        };
                        deltaPct?: {
                            gte?: number;
                            lt?: number;
                        };
                        isOverAllocation?: boolean;
                        level?: {
                            gte?: number;
                            lte?: number;
                        };
                        dimension?: {
                            [key: string]: string[];
                        };
                        daysRemaining?: {
                            lt?: number;
                        };
                        metricKey?: string[];
                        any?: unknown[];
                    };
                    chain: {
                        /** @enum {string} */
                        role: "PLANNER" | "BUDGET_OWNER" | "APPROVER" | "FINANCE" | "WORKSPACE_ADMIN";
                        /** Format: uuid */
                        groupId?: string;
                        /** @default 1 */
                        minApprovals?: number;
                        /** @default 48 */
                        timeoutHours?: number;
                        /** @enum {string} */
                        escalateTo?: "FINANCE" | "WORKSPACE_ADMIN";
                    }[];
                    /** @default false */
                    allowExternalEvidence?: boolean;
                    /** @default true */
                    blockSelfApproval?: boolean;
                };
            };
        };
        responses: {
            /** @description Created policy */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updatePolicy: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    version: number;
                    name?: string;
                    priority?: number;
                    conditions?: {
                        /** @enum {string} */
                        entityType?: "envelope_version" | "target_version" | "bulk_change";
                        amountAbs?: {
                            gte?: number;
                            lt?: number;
                        };
                        deltaAbs?: {
                            gte?: number;
                            lt?: number;
                        };
                        deltaPct?: {
                            gte?: number;
                            lt?: number;
                        };
                        isOverAllocation?: boolean;
                        level?: {
                            gte?: number;
                            lte?: number;
                        };
                        dimension?: {
                            [key: string]: string[];
                        };
                        daysRemaining?: {
                            lt?: number;
                        };
                        metricKey?: string[];
                        any?: unknown[];
                    };
                    chain?: {
                        /** @enum {string} */
                        role: "PLANNER" | "BUDGET_OWNER" | "APPROVER" | "FINANCE" | "WORKSPACE_ADMIN";
                        /** Format: uuid */
                        groupId?: string;
                        /** @default 1 */
                        minApprovals?: number;
                        /** @default 48 */
                        timeoutHours?: number;
                        /** @enum {string} */
                        escalateTo?: "FINANCE" | "WORKSPACE_ADMIN";
                    }[];
                    allowExternalEvidence?: boolean;
                    blockSelfApproval?: boolean;
                    isActive?: boolean;
                };
            };
        };
        responses: {
            /** @description Updated policy (version + 1) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Stale version */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    syncGroups: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    groups: {
                        /** Format: email */
                        googleGroup: string;
                        name: string;
                        members: string[];
                    }[];
                };
            };
        };
        responses: {
            /** @description Group membership after sync */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listDimensions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Registry dimensions visible to the workspace */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createDimension: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    key: string;
                    label: string;
                    description?: string;
                    /** @enum {string} */
                    dataType: "ENUM" | "TEXT" | "REFERENCE" | "DATE_BUCKET";
                    icon: string;
                    color?: string;
                    /** @default [] */
                    allowedParents?: string[];
                    /** @default false */
                    isRequiredForLeaf?: boolean;
                    /** @default 0 */
                    sortOrder?: number;
                    /** Format: uuid */
                    workspaceId: string | null;
                };
            };
        };
        responses: {
            /** @description Created dimension */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateDimension: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    label?: string;
                    description?: string | null;
                    icon?: string;
                    color?: string | null;
                    allowedParents?: string[];
                    isRequiredForLeaf?: boolean;
                    sortOrder?: number;
                    isActive?: boolean;
                };
            };
        };
        responses: {
            /** @description Updated dimension */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    addDimensionValues: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    values: {
                        code: string;
                        label: string;
                        parentCode?: string;
                        /** @default [] */
                        aliases?: string[];
                        /** @default {} */
                        externalIds?: {
                            [key: string]: string;
                        };
                    }[];
                };
            };
        };
        responses: {
            /** @description Upserted dimension values */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateDimensionValue: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    label?: string;
                    aliases?: string[];
                    externalIds?: {
                        [key: string]: string;
                    };
                    isActive?: boolean;
                };
            };
        };
        responses: {
            /** @description Updated dimension value */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    mergeDimensionValues: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    fromCode: string;
                    intoCode: string;
                };
            };
        };
        responses: {
            /** @description Merged dimension value */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listHierarchyTemplates: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Hierarchy templates */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    saveHierarchyTemplate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    path: string[];
                    /** @default false */
                    isDefault?: boolean;
                };
            };
        };
        responses: {
            /** @description Saved hierarchy template */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listMetrics: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The org's metric library (numerator / denominator over facts, multiplier) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createMetric: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    key: string;
                    label: string;
                    numerator: string;
                    /** @default null */
                    denominator?: string | null;
                    /** @default 1 */
                    multiplier?: string;
                    /** @enum {string} */
                    direction: "lower_is_better" | "higher_is_better";
                    /** @enum {string} */
                    format: "currency" | "number" | "percent" | "ratio";
                    unit?: string;
                };
            };
        };
        responses: {
            /** @description Created metric (org admin only) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listTargets: {
        parameters: {
            query?: {
                metric?: string;
                envelopeId?: string;
                scopeType?: "envelope" | "filter";
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Active targets with their current and draft versions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createTarget: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    scope: {
                        /** @enum {string} */
                        type: "envelope";
                        /** Format: uuid */
                        envelopeId: string;
                    } | {
                        /** @enum {string} */
                        type: "filter";
                        filter: unknown | Record<string, never>;
                    };
                    metricKey: string;
                    startDate?: string;
                    endDate?: string;
                    /** Format: uuid */
                    ownerId?: string;
                    value: string;
                    /**
                     * @default lte
                     * @enum {string}
                     */
                    comparator?: "lte" | "gte" | "eq" | "between";
                    valueUpper?: string;
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description Created target with its v1 draft */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createTargetDraft: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    basedOnVersionId: string | null;
                    value: string;
                    /**
                     * @default lte
                     * @enum {string}
                     */
                    comparator?: "lte" | "gte" | "eq" | "between";
                    valueUpper?: string;
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description New draft version; 409 with currentVersionId when basedOnVersionId is stale */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    submitTarget: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    versionId: string;
                };
            };
        };
        responses: {
            /** @description Approval request, or auto-approved by policy (entityType target_version) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listTargetVersions: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Target with every version, newest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getEnvelopeTargets: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Effective target per metric (own, inherited or filter-scoped) with implied volume = budget / target */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listSources: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Data sources (non-secret config and column mapping) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createSource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    config: {
                        /** @enum {string} */
                        kind: "csv";
                        uri: string;
                    } | {
                        /** @enum {string} */
                        kind: "snowflake";
                        account: string;
                        username: string;
                        warehouse: string;
                        database: string;
                        schema: string;
                        view: string;
                        secretRef: string;
                    } | {
                        /** @enum {string} */
                        kind: "sheets";
                        spreadsheetId: string;
                        range: string;
                        secretRef?: string;
                    } | {
                        /** @enum {string} */
                        kind: "bigquery";
                        projectId: string;
                        dataset: string;
                        table: string;
                        updatedAtColumn?: string;
                        secretRef?: string;
                    };
                    mapping: {
                        columns: {
                            [key: string]: {
                                dimension: string;
                                /** @enum {string} */
                                transform?: "lower" | "upper" | "trim";
                                valueMap?: {
                                    [key: string]: string;
                                };
                            } | ({
                                /** @enum {string} */
                                role: "period_date";
                                /**
                                 * @default yyyy-MM-dd
                                 * @enum {string}
                                 */
                                format?: "yyyy-MM-dd" | "yyyy-MM" | "dd/MM/yyyy" | "MM/dd/yyyy";
                            } | {
                                /** @enum {string} */
                                role: "amount";
                                currency?: string;
                            } | {
                                /** @enum {string} */
                                role: "currency";
                            } | {
                                /** @enum {string} */
                                role: "kpi";
                                metric: string;
                                attributionModel?: string;
                            } | {
                                /** @enum {string} */
                                role: "projection";
                                /** @default spend */
                                metric?: string;
                            } | {
                                /** @enum {string} */
                                role: "formula_version";
                            } | {
                                /** @enum {string} */
                                role: "horizon_end";
                            } | {
                                /** @enum {string} */
                                role: "ignore";
                            });
                        };
                        /** @enum {string} */
                        kind: "spend" | "kpi" | "spend+kpi" | "projection";
                    };
                    schedule?: string;
                };
            };
        };
        responses: {
            /** @description Created source; a csv source must point at this workspace's uploads */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateSource: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name?: string;
                    config?: {
                        /** @enum {string} */
                        kind: "csv";
                        uri: string;
                    } | {
                        /** @enum {string} */
                        kind: "snowflake";
                        account: string;
                        username: string;
                        warehouse: string;
                        database: string;
                        schema: string;
                        view: string;
                        secretRef: string;
                    } | {
                        /** @enum {string} */
                        kind: "sheets";
                        spreadsheetId: string;
                        range: string;
                        secretRef?: string;
                    } | {
                        /** @enum {string} */
                        kind: "bigquery";
                        projectId: string;
                        dataset: string;
                        table: string;
                        updatedAtColumn?: string;
                        secretRef?: string;
                    };
                    mapping?: {
                        columns: {
                            [key: string]: {
                                dimension: string;
                                /** @enum {string} */
                                transform?: "lower" | "upper" | "trim";
                                valueMap?: {
                                    [key: string]: string;
                                };
                            } | ({
                                /** @enum {string} */
                                role: "period_date";
                                /**
                                 * @default yyyy-MM-dd
                                 * @enum {string}
                                 */
                                format?: "yyyy-MM-dd" | "yyyy-MM" | "dd/MM/yyyy" | "MM/dd/yyyy";
                            } | {
                                /** @enum {string} */
                                role: "amount";
                                currency?: string;
                            } | {
                                /** @enum {string} */
                                role: "currency";
                            } | {
                                /** @enum {string} */
                                role: "kpi";
                                metric: string;
                                attributionModel?: string;
                            } | {
                                /** @enum {string} */
                                role: "projection";
                                /** @default spend */
                                metric?: string;
                            } | {
                                /** @enum {string} */
                                role: "formula_version";
                            } | {
                                /** @enum {string} */
                                role: "horizon_end";
                            } | {
                                /** @enum {string} */
                                role: "ignore";
                            });
                        };
                        /** @enum {string} */
                        kind: "spend" | "kpi" | "spend+kpi" | "projection";
                    };
                    schedule?: string | null;
                    isActive?: boolean;
                };
            };
        };
        responses: {
            /** @description Updated source (the kind never changes) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    suggestSourceMapping: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Suggested column mapping from @budget/ai (not applied); 503 without OPENAI_API_KEY */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    runSource: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    restatementOf?: string;
                };
            };
        };
        responses: {
            /** @description Queued ingest run (the ingest worker runs it); 409 while a run is queued or running. restatementOf lets it load facts into that closed period */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listSourceRuns: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Runs, newest first: counts, match coverage summary, rejected-rows report URI */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listUnmatchedSpend: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Unmatched spend grouped by dimension tuple, largest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    mapUnmatchedSpend: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    dimensionValues: {
                        [key: string]: string;
                    };
                    /** Format: uuid */
                    envelopeId: string;
                };
            };
        };
        responses: {
            /** @description Facts assigned to the envelope, per fact table */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createUpload: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    filename: string;
                };
            };
        };
        responses: {
            /** @description gs:// URI and a URL to PUT the CSV to */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listClosures: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Closures, newest first (restated ones included) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    closePeriod: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    periodId?: string;
                    periodKey?: string;
                };
            };
        };
        responses: {
            /** @description Closed: overlapping envelopes are LOCKED and the rows are in the closure table */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        workspaceId: string;
                        period: {
                            /** Format: uuid */
                            id: string;
                            key: string;
                            kind: string;
                            start: string;
                            end: string;
                        };
                        /** @enum {string} */
                        status: "closed" | "restated";
                        /** Format: uuid */
                        closedBy: string;
                        /** Format: date-time */
                        closedAt: string;
                        table: string;
                        lockedEnvelopes: number;
                    };
                };
            };
            /** @description The period is already closed, or has not ended */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No closure sink (BigQuery) in this environment */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    restateClosure: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Restated; envelopes no other closed closure covers get their prior status back */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getClosureReport: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The frozen report: variance summary and registry snapshot as stored at close */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createExport: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    kind: "csv" | "xlsx" | "sheets";
                    query: {
                        /** Format: uuid */
                        workspaceId: string;
                        filter?: {
                            /** @enum {string} */
                            logic: "and" | "or";
                            not?: boolean;
                            children: ({
                                field: {
                                    /** @enum {string} */
                                    kind: "dimension";
                                    key: string;
                                } | {
                                    /** @enum {string} */
                                    kind: "measure";
                                    /** @enum {string} */
                                    key: "budget" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct";
                                } | {
                                    /** @enum {string} */
                                    kind: "target";
                                    metric: string;
                                    /** @enum {string} */
                                    field: "value" | "actual" | "vs_target_pct" | "exists";
                                } | {
                                    /** @enum {string} */
                                    kind: "attr";
                                    /** @enum {string} */
                                    key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf";
                                };
                                /** @enum {string} */
                                op: "eq" | "neq" | "in" | "nin" | "contains" | "starts_with" | "is_empty" | "not_empty" | "between" | "gt" | "gte" | "lt" | "lte" | "descends_from" | "within";
                                value?: string | number | boolean | (string | number)[] | ((string | number) | (string | number))[] | {
                                    /** @enum {string} */
                                    unit: "day" | "week" | "month" | "quarter" | "year";
                                    amount: number;
                                    /**
                                     * @default today
                                     * @enum {string}
                                     */
                                    anchor?: "today" | "period_start" | "period_end";
                                } | unknown;
                            } | unknown)[];
                        };
                        /** @default [] */
                        groupBy?: string[];
                        /**
                         * @default [
                         *       "budget",
                         *       "actual",
                         *       "projected",
                         *       "pace_index"
                         *     ]
                         */
                        measures?: ("budget" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct")[];
                        /** @default [] */
                        targets?: string[];
                        period: {
                            /** @enum {string} */
                            kind: "fiscal";
                            key: string;
                        } | {
                            /** @enum {string} */
                            kind: "range";
                            start: string;
                            end: string;
                        } | {
                            /** @enum {string} */
                            kind: "relative";
                            /** @enum {string} */
                            preset: "current_month" | "current_quarter" | "current_year" | "last_30_days" | "last_90_days" | "ytd" | "next_90_days";
                        };
                        /**
                         * @default total
                         * @enum {string}
                         */
                        grain?: "total" | "day" | "week" | "month" | "quarter";
                        /** Format: date-time */
                        asOf?: string;
                        /** Format: uuid */
                        templateId?: string;
                        /** @default [] */
                        sort?: {
                            key: string;
                            /** @enum {string} */
                            dir: "asc" | "desc";
                        }[];
                        cursor?: string;
                        /** @default 200 */
                        limit?: number;
                    };
                    filename?: string;
                };
            };
        };
        responses: {
            /** @description Queued export job; the caller's read scope is ANDed into the filter */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        workspaceId: string;
                        /** @enum {string} */
                        kind: "csv" | "xlsx" | "sheets";
                        /** @enum {string} */
                        status: "queued" | "running" | "done" | "failed";
                        filename: string;
                        rowCount: number | null;
                        error: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        completedAt: string | null;
                        downloadUrl: string | null;
                        expiresInSeconds: number | null;
                    };
                };
            };
            /** @description kind sheets: Sheets push is not configured in this environment */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getExport: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller's export job; downloadUrl while done */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** Format: uuid */
                        workspaceId: string;
                        /** @enum {string} */
                        kind: "csv" | "xlsx" | "sheets";
                        /** @enum {string} */
                        status: "queued" | "running" | "done" | "failed";
                        filename: string;
                        rowCount: number | null;
                        error: string | null;
                        /** Format: date-time */
                        createdAt: string;
                        /** Format: date-time */
                        completedAt: string | null;
                        downloadUrl: string | null;
                        expiresInSeconds: number | null;
                    };
                };
            };
        };
    };
    getPacing: {
        parameters: {
            query?: {
                /** @description FilterGroup as JSON */
                filter?: string;
                /** @description Preset name (current_year, current_quarter, …) or a PeriodSpec as JSON; default current_year */
                period?: string;
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pace measures per envelope, CPA vs target, open alerts, totals */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listRules: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pacing rules */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createRule: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    scope?: unknown;
                    /** @enum {string} */
                    metric: "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "projected_variance_abs" | "kpi_vs_target_pct" | "implied_volume_gap" | "efficiency_adjusted_pace";
                    /** @default {} */
                    metricArgs?: {
                        metricKey?: string;
                        period?: {
                            /** @enum {string} */
                            kind: "fiscal";
                            key: string;
                        } | {
                            /** @enum {string} */
                            kind: "range";
                            start: string;
                            end: string;
                        } | {
                            /** @enum {string} */
                            kind: "relative";
                            /** @enum {string} */
                            preset: "current_month" | "current_quarter" | "current_year" | "last_30_days" | "last_90_days" | "ytd" | "next_90_days";
                        };
                        daysRemainingLt?: number;
                    };
                    /** @enum {string} */
                    comparator: "gt" | "gte" | "lt" | "lte";
                    threshold: string;
                    /** @default 1 */
                    consecutiveDays?: number;
                    /** @enum {string} */
                    severity: "info" | "warning" | "critical" | "data";
                    /**
                     * @default {
                     *       "inApp": true
                     *     }
                     */
                    delivery?: {
                        /** @default true */
                        inApp?: boolean;
                        slackChannel?: string;
                        emails?: string[];
                    };
                };
            };
        };
        responses: {
            /** @description Created rule (workspace-wide rule.manage role) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateRule: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name?: string;
                    scope?: unknown;
                    /** @enum {string} */
                    metric?: "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "projected_variance_abs" | "kpi_vs_target_pct" | "implied_volume_gap" | "efficiency_adjusted_pace";
                    metricArgs?: {
                        metricKey?: string;
                        period?: {
                            /** @enum {string} */
                            kind: "fiscal";
                            key: string;
                        } | {
                            /** @enum {string} */
                            kind: "range";
                            start: string;
                            end: string;
                        } | {
                            /** @enum {string} */
                            kind: "relative";
                            /** @enum {string} */
                            preset: "current_month" | "current_quarter" | "current_year" | "last_30_days" | "last_90_days" | "ytd" | "next_90_days";
                        };
                        daysRemainingLt?: number;
                    };
                    /** @enum {string} */
                    comparator?: "gt" | "gte" | "lt" | "lte";
                    threshold?: string;
                    consecutiveDays?: number;
                    /** @enum {string} */
                    severity?: "info" | "warning" | "critical" | "data";
                    delivery?: {
                        /** @default true */
                        inApp?: boolean;
                        slackChannel?: string;
                        emails?: string[];
                    };
                    isActive?: boolean;
                };
            };
        };
        responses: {
            /** @description Updated rule */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listAlerts: {
        parameters: {
            query?: {
                /** @description Comma-separated OPEN, ACKNOWLEDGED, SNOOZED, RESOLVED; default the open ones */
                status?: string;
                severity?: "info" | "warning" | "critical" | "data";
                ruleId?: string;
                envelopeId?: string;
                /** @description FilterGroup as JSON */
                filter?: string;
                limit?: number;
            };
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Alerts, newest first, within the caller's scope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateAlert: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    status?: "ACKNOWLEDGED" | "SNOOZED" | "RESOLVED";
                    /** Format: date-time */
                    snoozedUntil?: string;
                    /** Format: uuid */
                    ownerId?: string | null;
                };
            };
        };
        responses: {
            /** @description Updated alert; 409 once resolved */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listThreads: {
        parameters: {
            query: {
                anchorType: string;
                anchorId: string;
            };
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The anchor's threads with comments (deleted ones without body) and display names */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createThread: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    anchorType: "envelope" | "envelope_version" | "target" | "approval_request" | "alert" | "closure" | "dimension_value" | "cell" | "diff_field";
                    /** Format: uuid */
                    anchorId: string;
                    /** @default {} */
                    anchorMeta?: {
                        month?: string;
                        field?: string;
                    };
                    title?: string;
                    /** @default false */
                    isBlocking?: boolean;
                    firstComment: {
                        bodyMd: string;
                        /** Format: uuid */
                        parentCommentId?: string;
                        /** @default [] */
                        attachments?: {
                            gcsUri: string;
                            name: string;
                            sha256: string;
                        }[];
                    };
                };
            };
        };
        responses: {
            /** @description Created thread with its first comment; only envelope and target threads can block */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    addComment: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    bodyMd: string;
                    /** Format: uuid */
                    parentCommentId?: string;
                    /** @default [] */
                    attachments?: {
                        gcsUri: string;
                        name: string;
                        sha256: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Created comment; mentions notify through notify-worker */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteComment: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Soft-deleted comment (author or workspace admin) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    editComment: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    bodyMd: string;
                };
            };
        };
        responses: {
            /** @description Edited comment (author only; history kept) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    resolveThread: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resolved (thread author, anchor owner, eligible approver or admin) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    reopenThread: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reopened */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    setSubscription: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    entityType: "envelope" | "target" | "alert" | "approval_request" | "thread";
                    /** Format: uuid */
                    entityId: string;
                    /** @default true */
                    subscribed?: boolean;
                };
            };
        };
        responses: {
            /** @description Follow or stop following an entity's threads */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listTags: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tags with usage counts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createTag: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    color?: string;
                    /**
                     * @default label
                     * @enum {string}
                     */
                    kind?: "label" | "status" | "team" | "custom";
                };
            };
        };
        responses: {
            /** @description Created tag */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateTag: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name?: string;
                    color?: string | null;
                    /** @enum {string} */
                    kind?: "label" | "status" | "team" | "custom";
                    /** Format: uuid */
                    mergeIntoId?: string;
                };
            };
        };
        responses: {
            /** @description Renamed, recoloured, or merged into another tag */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    applyTag: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    tagId: string;
                    entities: {
                        /** @enum {string} */
                        type: "envelope" | "target" | "alert" | "approval_request" | "thread";
                        /** Format: uuid */
                        id: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Tagged up to 10k entities (duplicates skipped) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    removeTag: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    tagId: string;
                    entities: {
                        /** @enum {string} */
                        type: "envelope" | "target" | "alert" | "approval_request" | "thread";
                        /** Format: uuid */
                        id: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Untagged the entities */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    search: {
        parameters: {
            query?: {
                /** @description Free text plus qualifiers: type:, status:, owner:@me, tag:, period:, budget:>N, cpa:>target, has:open-thread, mentions:@me, updated:<7d, <dimension key>:<code> */
                q?: string;
                /** @description Comma-separated entity types */
                types?: string;
                /** @description Hits per type (default 5) */
                limit?: number;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description { groups: [{ type, count, hits: [{ id, title, path, status, facets, deepLink }] }], parsed } */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    searchSuggest: {
        parameters: {
            query?: {
                /** @description A qualifier-key prefix, or key: plus a value prefix */
                prefix?: string;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description { keys: [{ key, label, kind }], values: [{ value, label }] } */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    uploadIconAsset: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    contentType: "image/svg+xml";
                    svg: string;
                };
            };
        };
        responses: {
            /** @description Sanitized SVG icon asset */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}
