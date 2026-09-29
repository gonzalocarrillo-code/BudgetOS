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
        patch: operations["updateMe"];
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
    "/api/v1/workspaces/{ws}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listMembers"];
        put?: never;
        post: operations["addMember"];
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
    "/api/v1/envelopes/{id}/spend": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getEnvelopeSpend"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/end": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["endEnvelope"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/reintroduce": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reintroduceEnvelope"];
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
    "/api/v1/envelopes/structure/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["previewEnvelopeStructure"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/children": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["addChildEnvelope"];
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
    "/api/v1/envelopes/{id}/family": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getEnvelopeFamily"];
        put?: never;
        post: operations["saveEnvelopeFamily"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/envelopes/{id}/family/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["previewEnvelopeFamily"];
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
    "/api/v1/hierarchy-templates/{id}": {
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
        patch: operations["updateHierarchyTemplate"];
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
    "/api/v1/workspaces/{ws}/mapping-suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["suggestMappingFromSample"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
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
    "/api/v1/comments/{id}/reactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["addReaction"];
        delete: operations["removeReaction"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/people": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listPeople"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["query"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["tree"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/manual-entries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listManualEntries"];
        put?: never;
        post: operations["createManualEntry"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/manual-entries/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getManualEntry"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateManualEntry"];
        trace?: never;
    };
    "/api/v1/manual-entries/{id}/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submitManualEntry"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/home": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getHome"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tours": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listTours"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tours/{id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["completeTour"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tours/{id}": {
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
        patch: operations["updateTour"];
        trace?: never;
    };
    "/api/v1/workspace-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listWorkspaceTemplates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listWorkspaces"];
        put?: never;
        post: operations["createWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteWorkspace"];
        options?: never;
        head?: never;
        patch: operations["setWorkspaceStatus"];
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/undelete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["undeleteWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["myNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/me/notifications/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["readNotifications"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/baselines": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listBaselines"];
        put?: never;
        post: operations["saveBaseline"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/baselines/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getBaseline"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateBaseline"];
        trace?: never;
    };
    "/api/v1/baselines/{id}/rows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getBaselineRows"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/baselines/{id}/export.csv": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["exportBaselineCsv"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/baselines/{id}/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["baselineReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/org/people": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listOrgPeople"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/org/people/{id}": {
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
        patch: operations["updateOrgPerson"];
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/demo-data": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getDemoData"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/demo-data/purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["purgeDemoData"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/experiments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listExperiments"];
        put?: never;
        post: operations["createExperiment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/experiments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getExperiment"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateExperiment"];
        trace?: never;
    };
    "/api/v1/experiments/{id}/link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["linkExperimentEnvelope"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/experiments/{id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["startExperiment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/experiments/{id}/evaluate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["evaluateExperiment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/experiments/{id}/abandon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["abandonExperiment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/experiments/{id}/conclude": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["concludeExperiment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/timeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getTimeline"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/saved-views": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listSavedViews"];
        put?: never;
        post: operations["createSavedView"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/saved-views/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteSavedView"];
        options?: never;
        head?: never;
        patch: operations["updateSavedView"];
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/periods": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listPeriods"];
        put?: never;
        post: operations["createPeriod"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/periods/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["generatePeriods"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/fiscal-year": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFiscalYearStart"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["setFiscalYearStart"];
        trace?: never;
    };
    "/api/v1/periods/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deletePeriod"];
        options?: never;
        head?: never;
        patch: operations["updatePeriod"];
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
    "/api/v1/workspaces/{ws}/naming-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listNamingTemplates"];
        put?: never;
        post: operations["createNamingTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/naming-templates/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["previewNamingTemplate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/naming-templates/{id}": {
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
        patch: operations["updateNamingTemplate"];
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getOverview"];
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
        delete: operations["deleteRule"];
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
    "/api/v1/workspaces/{ws}/general": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getWorkspaceGeneral"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateWorkspaceGeneral"];
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/integrations/slack": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSlackSettings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateSlackSettings"];
        trace?: never;
    };
    "/api/v1/workspaces/{ws}/integrations/slack/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["sendSlackTest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/slack/interactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Called by Slack (signed with SLACK_SIGNING_SECRET; no JWT): button clicks and form submissions */
        post: operations["slackInteractions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/slack/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** @description Called by Slack (signed; no JWT): the /budget slash command */
        post: operations["slackCommands"];
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
    "/api/v1/workspaces/{ws}/tags/applied": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["appliedTags"];
        put?: never;
        post?: never;
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
    "/api/v1/assets/icons/{file}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getIconAsset"];
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
    updateMe: {
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
                    name: string;
                };
            };
        };
        responses: {
            /** @description The caller's new display name */
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
    listMembers: {
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
            /** @description The people and groups with a role in this workspace (a superadmin sees the whole org), each with its role assignments here */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        users: {
                            /** Format: uuid */
                            id: string;
                            email: string;
                            name: string;
                            isActive: boolean;
                            signedIn: boolean;
                            orgAdmin: boolean;
                            roles: {
                                /** Format: uuid */
                                id: string;
                                role: string;
                                scope: unknown;
                            }[];
                        }[];
                        groups: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            googleGroup: string;
                            memberCount: number;
                            roles: {
                                /** Format: uuid */
                                id: string;
                                role: string;
                                scope: unknown;
                            }[];
                        }[];
                    };
                };
            };
        };
    };
    addMember: {
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
                    /** Format: email */
                    email: string;
                    name: string;
                    /** @enum {string} */
                    role?: "VIEWER" | "PLANNER" | "BUDGET_OWNER" | "APPROVER" | "FINANCE" | "DATA_ADMIN" | "WORKSPACE_ADMIN";
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
            /** @description Added to this workspace by email with a role here (joins the org when new); they sign in with Google later */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The email belongs to another organisation */
            409: {
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
                    useTemplateName?: boolean;
                    dimensionValues?: {
                        [key: string]: string;
                    };
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
    getEnvelopeSpend: {
        parameters: {
            query?: {
                through?: string;
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
            /** @description Spend up to a date in the budget's currency: { through, currency, spend } (H-011) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    endEnvelope: {
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
                    endDate: string;
                    finalAmount: string;
                    /** @default  */
                    rationale?: string;
                    /** Format: uuid */
                    basedOnVersionId: string;
                    successor?: {
                        name?: string;
                        startDate: string;
                        endDate: string;
                        amount: string;
                    };
                };
            };
        };
        responses: {
            /** @description A final-amount version (and an optional successor) routed through the approval policy; the end date applies on approval (H-011) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    reintroduceEnvelope: {
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
                    startDate: string;
                    endDate: string;
                    amount: string;
                    /** @default  */
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description A successor under the same parent with lineage `continues`, routed through the approval policy (H-012) */
            200: {
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
    previewEnvelopeStructure: {
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
                    op: "add_child";
                    /** Format: uuid */
                    envelopeId: string;
                    input: {
                        name: string;
                        amount: string;
                        /** @default {} */
                        dimensionValues?: {
                            [key: string]: string;
                        };
                        rationale: string;
                    };
                } | {
                    /** @enum {string} */
                    op: "move";
                    /** Format: uuid */
                    envelopeId: string;
                    input: {
                        /** Format: uuid */
                        parentId: string | null;
                        rowVersion: number;
                        rationale?: string;
                    };
                } | {
                    /** @enum {string} */
                    op: "split";
                    /** Format: uuid */
                    envelopeId: string;
                    input: {
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
                } | {
                    /** @enum {string} */
                    op: "merge";
                    input: {
                        sourceIds: string[];
                        name: string;
                        dimensionValues: {
                            [key: string]: string;
                        };
                        rationale: string;
                    };
                } | {
                    /** @enum {string} */
                    op: "end";
                    /** Format: uuid */
                    envelopeId: string;
                    input: {
                        endDate: string;
                        finalAmount: string;
                        /** @default  */
                        rationale?: string;
                        /** Format: uuid */
                        basedOnVersionId: string;
                        successor?: {
                            name?: string;
                            startDate: string;
                            endDate: string;
                            amount: string;
                        };
                    };
                } | {
                    /** @enum {string} */
                    op: "reintroduce";
                    /** Format: uuid */
                    envelopeId: string;
                    input: {
                        name?: string;
                        startDate: string;
                        endDate: string;
                        amount: string;
                        /** @default  */
                        rationale?: string;
                    };
                };
            };
        };
        responses: {
            /** @description { ok, op, currency, amount, parent, previousParent, routing } or { ok: false, error }: the change is run and rolled back */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    addChildEnvelope: {
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
                    name: string;
                    amount: string;
                    /** @default {} */
                    dimensionValues?: {
                        [key: string]: string;
                    };
                    rationale: string;
                };
            };
        };
        responses: {
            /** @description The child, created under this envelope with its draft submitted (auto-approved or a request) */
            201: {
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
                                    key: "budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct";
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
                                    key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf" | "parent_id" | "experiment";
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
                                    key: "budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct";
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
                                    key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf" | "parent_id" | "experiment";
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
    getEnvelopeFamily: {
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
            /** @description The parent, its children (each % of the parent or manual) and how they add up */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        parent: {
                            /** Format: uuid */
                            envelopeId: string;
                            name: string;
                            /** Format: uuid */
                            parentId: string | null;
                            level: number;
                            currency: string;
                            status: string;
                            /** @enum {string|null} */
                            mode: "percent" | "manual" | null;
                            pct: string | null;
                            before: string | null;
                            after: string | null;
                            changed: boolean;
                            childCount: number;
                            sameCurrency: boolean;
                        };
                        members: {
                            /** Format: uuid */
                            envelopeId: string;
                            name: string;
                            /** Format: uuid */
                            parentId: string | null;
                            level: number;
                            currency: string;
                            status: string;
                            /** @enum {string|null} */
                            mode: "percent" | "manual" | null;
                            pct: string | null;
                            before: string | null;
                            after: string | null;
                            changed: boolean;
                            childCount: number;
                            sameCurrency: boolean;
                        }[];
                        sums: {
                            /** Format: uuid */
                            parentId: string;
                            parentAmount: string;
                            childrenTotal: string;
                            unallocated: string;
                            /** @enum {string} */
                            status: "balanced" | "under" | "over";
                        }[];
                    };
                };
            };
        };
    };
    saveEnvelopeFamily: {
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
                    parentAmount: string;
                    /** @default [] */
                    children?: {
                        /** Format: uuid */
                        envelopeId: string;
                        /** @enum {string} */
                        mode: "percent" | "manual";
                        pct?: string;
                        amount?: string;
                    }[];
                    /** @default Family edit */
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description Rules saved (audited); { plan, preview }: the bulk preview of every amount the plan changes, to commit (null when no amount changes) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    previewEnvelopeFamily: {
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
                    parentAmount: string;
                    /** @default [] */
                    children?: {
                        /** Format: uuid */
                        envelopeId: string;
                        /** @enum {string} */
                        mode: "percent" | "manual";
                        pct?: string;
                        amount?: string;
                    }[];
                    /** @default Family edit */
                    rationale?: string;
                };
            };
        };
        responses: {
            /** @description The family as the change leaves it, down the tree; writes nothing */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        parent: {
                            /** Format: uuid */
                            envelopeId: string;
                            name: string;
                            /** Format: uuid */
                            parentId: string | null;
                            level: number;
                            currency: string;
                            status: string;
                            /** @enum {string|null} */
                            mode: "percent" | "manual" | null;
                            pct: string | null;
                            before: string | null;
                            after: string | null;
                            changed: boolean;
                            childCount: number;
                            sameCurrency: boolean;
                        };
                        members: {
                            /** Format: uuid */
                            envelopeId: string;
                            name: string;
                            /** Format: uuid */
                            parentId: string | null;
                            level: number;
                            currency: string;
                            status: string;
                            /** @enum {string|null} */
                            mode: "percent" | "manual" | null;
                            pct: string | null;
                            before: string | null;
                            after: string | null;
                            changed: boolean;
                            childCount: number;
                            sameCurrency: boolean;
                        }[];
                        sums: {
                            /** Format: uuid */
                            parentId: string;
                            parentAmount: string;
                            childrenTotal: string;
                            unallocated: string;
                            /** @enum {string} */
                            status: "balanced" | "under" | "over";
                        }[];
                    };
                };
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
                        entityType?: "envelope_version" | "target_version" | "bulk_change" | "manual_entry";
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
                        requester?: {
                            roles?: ("VIEWER" | "PLANNER" | "BUDGET_OWNER" | "APPROVER" | "FINANCE" | "DATA_ADMIN" | "WORKSPACE_ADMIN" | "ORG_ADMIN")[];
                            userIds?: string[];
                        };
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
                        entityType?: "envelope_version" | "target_version" | "bulk_change" | "manual_entry";
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
                        requester?: {
                            roles?: ("VIEWER" | "PLANNER" | "BUDGET_OWNER" | "APPROVER" | "FINANCE" | "DATA_ADMIN" | "WORKSPACE_ADMIN" | "ORG_ADMIN")[];
                            userIds?: string[];
                        };
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
            /** @description Superadmins: group membership after sync */
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
                    parentCode?: string | null;
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
    updateHierarchyTemplate: {
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
                    path?: string[];
                    isDefault?: boolean;
                };
            };
        };
        responses: {
            /** @description Updated hierarchy template (rename, reorder, make default) */
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
                                role: "match_key";
                            } | {
                                /** @enum {string} */
                                role: "ignore";
                            });
                        };
                        /** @enum {string} */
                        kind: "spend" | "kpi" | "spend+kpi" | "projection";
                    };
                    schedule?: string;
                    parsePattern?: string;
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
                                role: "match_key";
                            } | {
                                /** @enum {string} */
                                role: "ignore";
                            });
                        };
                        /** @enum {string} */
                        kind: "spend" | "kpi" | "spend+kpi" | "projection";
                    };
                    schedule?: string | null;
                    parsePattern?: string | null;
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
    suggestMappingFromSample: {
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
                    header: string[];
                    rows: (string | number | unknown)[][];
                };
            };
        };
        responses: {
            /** @description A suggested mapping for a file's header and first rows (nothing saved); 503 without OPENAI_API_KEY */
            201: {
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
    addReaction: {
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
                    emoji: "👍" | "✅" | "👀" | "🎉" | "❤️" | "❓";
                };
            };
        };
        responses: {
            /** @description The caller's reaction (idempotent); the emoji's count */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    removeReaction: {
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
                    emoji: "👍" | "✅" | "👀" | "🎉" | "❤️" | "❓";
                };
            };
        };
        responses: {
            /** @description The caller's reaction removed (idempotent); the emoji's count */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listPeople: {
        parameters: {
            query?: {
                q?: string;
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
            /** @description Accounts and groups that can be @mentioned here */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    query: {
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
                                key: "budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct";
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
                                key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf" | "parent_id" | "experiment";
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
                    measures?: ("budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct")[];
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
                    compareTo?: {
                        /** Format: uuid */
                        baselineId: string;
                    } | {
                        /** Format: date-time */
                        asOf: string;
                    };
                    /** Format: uuid */
                    templateId?: string;
                    subtree?: boolean;
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
            };
        };
        responses: {
            /** @description One page of planner rows, the totals and the data version; the caller's read scope is ANDed into the filter */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        rows: {
                            key: string;
                            /** Format: uuid */
                            envelopeId: string | null;
                            /** Format: uuid */
                            versionId?: string | null;
                            depth?: number;
                            /** Format: uuid */
                            nodeEnvelopeId?: string | null;
                            childCount?: number;
                            /** Format: uuid */
                            parentId?: string | null;
                            path: string[];
                            dimensions: {
                                [key: string]: string | null;
                            };
                            measures: {
                                [key: string]: string | null;
                            };
                            /** @default {} */
                            targets: {
                                [key: string]: {
                                    target: string | null;
                                    actual: string | null;
                                    vsTargetPct: string | null;
                                };
                            };
                            status: string | null;
                            /** @default 0 */
                            pendingCount: number;
                            /** @default 0 */
                            openAlerts: number;
                            /** @default 0 */
                            openThreads: number;
                        }[];
                        nextCursor: string | null;
                        totals: {
                            [key: string]: string | null;
                        };
                        /** Format: date-time */
                        dataAsOf: string;
                        dataVersion: number;
                        /** @enum {string} */
                        engine?: "postgres" | "warehouse" | "cache";
                        elapsedMs: number;
                    };
                };
            };
        };
    };
    tree: {
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
                    workspaceId: string;
                    /** Format: uuid */
                    templateId: string;
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
                    /** @default  */
                    parentPath?: string;
                    /**
                     * @default [
                     *       "budget",
                     *       "actual",
                     *       "projected",
                     *       "pace_index"
                     *     ]
                     */
                    measures?: ("budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct")[];
                };
            };
        };
        responses: {
            /** @description One level of a hierarchy template's tree from rollup_cache, with the root as totals; available: false (scoped caller or period not cached) means ask /query; X-Data-Version header */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        available: boolean;
                        /** @enum {string|null} */
                        reason: "scoped" | "not_cached" | null;
                        rows: {
                            key: string;
                            /** Format: uuid */
                            envelopeId: string | null;
                            /** Format: uuid */
                            versionId?: string | null;
                            depth?: number;
                            /** Format: uuid */
                            nodeEnvelopeId?: string | null;
                            childCount?: number;
                            /** Format: uuid */
                            parentId?: string | null;
                            path: string[];
                            dimensions: {
                                [key: string]: string | null;
                            };
                            measures: {
                                [key: string]: string | null;
                            };
                            /** @default {} */
                            targets: {
                                [key: string]: {
                                    target: string | null;
                                    actual: string | null;
                                    vsTargetPct: string | null;
                                };
                            };
                            status: string | null;
                            /** @default 0 */
                            pendingCount: number;
                            /** @default 0 */
                            openAlerts: number;
                            /** @default 0 */
                            openThreads: number;
                        }[];
                        totals: {
                            [key: string]: string | null;
                        };
                        /** Format: date-time */
                        dataAsOf: string;
                        dataVersion: number;
                        cacheVersion: number | null;
                        elapsedMs: number;
                    };
                };
            };
        };
    };
    listManualEntries: {
        parameters: {
            query?: {
                /** @description Comma-separated: DRAFT,SUBMITTED,APPROVED,REJECTED */
                status?: string;
                channel?: string;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Batches, newest first (rows omitted, rowCount) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createManualEntry: {
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
                    channel: string;
                    periodStart: string;
                    periodEnd: string;
                    /** @default [] */
                    rows?: {
                        rowNo?: number;
                        /** @default {} */
                        dimensionValues?: {
                            [key: string]: string;
                        };
                        /** @default  */
                        periodDate?: string;
                        /** @default  */
                        currency?: string;
                        /** @default  */
                        amount?: string;
                        /** @default {} */
                        kpis?: {
                            [key: string]: string;
                        };
                        note?: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description A DRAFT batch, its rows' issues (validated like ingestion) and warnings (rows no budget would take) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getManualEntry: {
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
            /** @description The batch, its issues and warnings, the latest approval decision and, once approved, the lineage of its facts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateManualEntry: {
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
                    channel?: string;
                    periodStart?: string;
                    periodEnd?: string;
                    rows?: {
                        rowNo?: number;
                        /** @default {} */
                        dimensionValues?: {
                            [key: string]: string;
                        };
                        /** @default  */
                        periodDate?: string;
                        /** @default  */
                        currency?: string;
                        /** @default  */
                        amount?: string;
                        /** @default {} */
                        kpis?: {
                            [key: string]: string;
                        };
                        note?: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Rows saved as typed, with their issues; only while DRAFT */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    submitManualEntry: {
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
            /** @description An approval request (entity_type manual_entry), or approved at once by an empty chain; 422 while a row has an issue */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getHome: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Waiting on me (approvals I can decide, mentions in open threads, alerts assigned to me, unmatched spend), then pacing per top-level budget, recents and saved views */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        waitingOnMe: {
                            approvals: {
                                /** Format: uuid */
                                id: string;
                                summary: string | null;
                                entityType: string;
                                requestedAt: string;
                                dueAt: string | null;
                            }[];
                            mentions: {
                                /** Format: uuid */
                                commentId: string;
                                /** Format: uuid */
                                threadId: string;
                                anchorType: string;
                                /** Format: uuid */
                                anchorId: string;
                                body: string;
                                author: string | null;
                                createdAt: string;
                            }[];
                            alerts: {
                                /** Format: uuid */
                                id: string;
                                /** Format: uuid */
                                envelopeId: string;
                                envelopeName: string;
                                severity: string;
                                openedAt: string;
                            }[];
                            unmatched: number;
                        };
                        scopes: {
                            label: string;
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
                                        key: "budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct";
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
                                        key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf" | "parent_id" | "experiment";
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
                                        anchor: "today" | "period_start" | "period_end";
                                    } | unknown;
                                } | unknown)[];
                            };
                            /** Format: uuid */
                            envelopeId?: string;
                            budget: string | null;
                            actual: string | null;
                            projected: string | null;
                            paceIndex: string | null;
                            spentPct: string | null;
                        }[];
                        recents: {
                            entityType: string;
                            /** Format: uuid */
                            entityId: string;
                            title: string;
                            at: string;
                        }[];
                        pinnedViews: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            screen: string;
                            definition: {
                                [key: string]: unknown;
                            };
                        }[];
                        workspace?: {
                            name: string;
                            currency: string;
                            period: {
                                start: string;
                                end: string;
                                elapsed: string | null;
                            };
                        };
                        totals?: {
                            budget: string | null;
                            actual: string | null;
                            spentPct: string | null;
                            openAlerts: number;
                        } | null;
                        setup?: {
                            budgets: number;
                            sources: number;
                            people: number;
                            spend: boolean;
                            tags: number;
                        };
                    };
                };
            };
        };
    };
    listTours: {
        parameters: {
            query?: {
                role?: "planner" | "approver" | "finance" | "data_admin";
                all?: "true" | "false";
            };
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller's role tours not completed at their current version (all=true: every one, with `completed`) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    completeTour: {
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
                    /** @default false */
                    dismissed?: boolean;
                };
            };
        };
        responses: {
            /** @description Recorded for the caller (idempotent) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateTour: {
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
                    steps?: {
                        path?: string;
                        element: string;
                        title: string;
                        description: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Workspace admins: a new version (a default becomes the workspace's copy) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listWorkspaceTemplates: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Org admins: the built-in default_agency template and the org's */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listWorkspaces: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Superadmins: every workspace of the org with its status, admins and counts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        workspaces: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            slug: string;
                            currency: string;
                            fiscalYearStartMonth: number;
                            /** @enum {string} */
                            status: "ACTIVE" | "ARCHIVED";
                            archivedAt: string | null;
                            deletedAt: string | null;
                            purgeAfter: string | null;
                            createdAt: string;
                            members: number;
                            budgets: number;
                            lastActivityAt: string | null;
                            admins: {
                                /** Format: uuid */
                                id: string;
                                name: string;
                                email: string;
                            }[];
                        }[];
                    };
                };
            };
        };
    };
    createWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    slug?: string;
                    /** Format: uuid */
                    templateId: string;
                    /** @default false */
                    withDemoData?: boolean;
                    /** @default USD */
                    reportingCurrency?: string;
                    /** @default 1 */
                    fiscalYearStartMonth?: number;
                    firstAdmin?: {
                        /** Format: email */
                        email: string;
                        name: string;
                    };
                };
            };
        };
        responses: {
            /** @description Org admins: a workspace from a template (hierarchy templates, policies, rules, a view, tours; missing org dimensions), with the demo dataset when asked */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteWorkspace: {
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
                    confirmName: string;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Superadmins: an archived workspace, its name typed, becomes a tombstone purged after the retention window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not archived, or already deleted */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    setWorkspaceStatus: {
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
                    status: "ACTIVE" | "ARCHIVED";
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description Superadmins: archived (read-only, hidden from its members) or restored */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    undeleteWorkspace: {
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
            /** @description Superadmins: back as archived, within the retention window */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    myNotifications: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller's latest notifications in the workspace and the unread count */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        rows: {
                            /** Format: uuid */
                            id: string;
                            kind: string;
                            payload: {
                                [key: string]: unknown;
                            };
                            readAt: string | null;
                            createdAt: string;
                        }[];
                        unread: number;
                    };
                };
            };
        };
    };
    readNotifications: {
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
                    ids?: string[];
                };
            };
        };
        responses: {
            /** @description How many notifications were marked read */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listBaselines: {
        parameters: {
            query?: {
                includeArchived?: "true" | "false";
                envelopeId?: string;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Snapshots, newest first (Phase E) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        baselines: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            kind: "plan" | "close" | "other";
                            scope: {
                                [key: string]: unknown;
                            };
                            scopeLabel: string | null;
                            periodKey: string | null;
                            asOf: string;
                            note: string | null;
                            takenBy: {
                                /** Format: uuid */
                                id: string;
                                name: string;
                            } | null;
                            createdAt: string;
                            archivedAt: string | null;
                            rowCount: number;
                            total: string;
                            row?: {
                                /** Format: uuid */
                                versionId: string | null;
                                amount: string;
                                currency: string;
                                name: string;
                                /** Format: uuid */
                                parentId: string | null;
                            } | null;
                        }[];
                    };
                };
            };
        };
    };
    saveBaseline: {
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
                     * @default other
                     * @enum {string}
                     */
                    kind?: "plan" | "close" | "other";
                    /** @default {} */
                    scope?: {
                        /** Format: uuid */
                        envelopeId: string;
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
                                    key: "budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct";
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
                                    key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf" | "parent_id" | "experiment";
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
                    } | Record<string, never>;
                    periodKey?: string;
                    note?: string;
                };
            };
        };
        responses: {
            /** @description A snapshot of the workspace, a filter or one budget's subtree, taken now */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getBaseline: {
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
            /** @description One snapshot */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string;
                        /** @enum {string} */
                        kind: "plan" | "close" | "other";
                        scope: {
                            [key: string]: unknown;
                        };
                        scopeLabel: string | null;
                        periodKey: string | null;
                        asOf: string;
                        note: string | null;
                        takenBy: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                        } | null;
                        createdAt: string;
                        archivedAt: string | null;
                        rowCount: number;
                        total: string;
                        row?: {
                            /** Format: uuid */
                            versionId: string | null;
                            amount: string;
                            currency: string;
                            name: string;
                            /** Format: uuid */
                            parentId: string | null;
                        } | null;
                    };
                };
            };
        };
    };
    updateBaseline: {
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
                    note?: string | null;
                    /** @enum {string} */
                    kind?: "plan" | "close" | "other";
                    archived?: boolean;
                };
            };
        };
        responses: {
            /** @description Renamed, re-noted or archived; its rows never change */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getBaselineRows: {
        parameters: {
            query?: {
                limit?: number;
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
            /** @description The snapshot's frozen rows as the tree they were saved in, cut to the caller's scope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        baseline: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            kind: "plan" | "close" | "other";
                            scope: {
                                [key: string]: unknown;
                            };
                            scopeLabel: string | null;
                            periodKey: string | null;
                            asOf: string;
                            note: string | null;
                            takenBy: {
                                /** Format: uuid */
                                id: string;
                                name: string;
                            } | null;
                            createdAt: string;
                            archivedAt: string | null;
                            rowCount: number;
                            total: string;
                            row?: {
                                /** Format: uuid */
                                versionId: string | null;
                                amount: string;
                                currency: string;
                                name: string;
                                /** Format: uuid */
                                parentId: string | null;
                            } | null;
                        };
                        rows: {
                            /** Format: uuid */
                            envelopeId: string;
                            /** Format: uuid */
                            parentId: string | null;
                            depth: number;
                            name: string;
                            isLeaf: boolean;
                            amount: string;
                            amountReporting: string;
                            currency: string;
                            /** Format: uuid */
                            versionId: string | null;
                            dimensionValues: {
                                [key: string]: string;
                            };
                            startDate: string;
                            endDate: string;
                            now: string | null;
                            change: string;
                            ended: boolean;
                        }[];
                        currency: string;
                        truncated: boolean;
                    };
                };
            };
        };
    };
    exportBaselineCsv: {
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
            /** @description The snapshot's rows as CSV (text/csv) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    baselineReport: {
        parameters: {
            query?: {
                against?: string;
                limit?: number;
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
            /** @description The snapshot against now or another snapshot */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        baseline: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            asOf: string;
                            total: string;
                        };
                        against: {
                            /** @enum {string} */
                            kind: "working" | "baseline";
                            /** Format: uuid */
                            id: string | null;
                            name: string;
                            asOf: string;
                            total: string;
                        };
                        change: {
                            abs: string;
                            pct: string | null;
                        };
                        counts: {
                            increased: number;
                            decreased: number;
                            new: number;
                            removed: number;
                            ended: number;
                            unchanged: number;
                        };
                        byDimension: {
                            [key: string]: {
                                code: string;
                                label: string;
                                baseline: string;
                                now: string;
                                abs: string;
                                pct: string | null;
                            }[];
                        };
                        topMovers: {
                            /** Format: uuid */
                            envelopeId: string;
                            name: string;
                            baseline: string;
                            now: string;
                            abs: string;
                            pct: string | null;
                            /** @enum {string} */
                            status: "changed" | "new" | "removed" | "ended";
                        }[];
                        currency: string;
                    };
                };
            };
        };
    };
    listOrgPeople: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Superadmins: everyone in the org and where they hold roles */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        people: {
                            /** Format: uuid */
                            id: string;
                            name: string;
                            email: string;
                            isActive: boolean;
                            signedIn: boolean;
                            superadmin: boolean;
                            workspaces: {
                                /** Format: uuid */
                                workspaceId: string;
                                name: string;
                                roles: string[];
                            }[];
                        }[];
                    };
                };
            };
        };
    };
    updateOrgPerson: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    isActive: boolean;
                };
            };
        };
        responses: {
            /** @description Superadmins: deactivate or reactivate someone */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getDemoData: {
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
            /** @description Demo rows left: envelopes and targets */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    purgeDemoData: {
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
            /** @description Every demo row deleted in one transaction; the template's configuration stays */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listExperiments: {
        parameters: {
            query?: {
                /** @description Comma-separated statuses (PLANNED,RUNNING,EVALUATING,CONCLUDED,ABANDONED) */
                status?: string;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Experiments, newest first, with their linked envelopes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createExperiment: {
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
                    hypothesis: string;
                    /** @enum {string} */
                    kind: "PLATFORM_TEST" | "OBJECTIVE_TEST" | "AUDIENCE_TEST" | "CREATIVE_TEST" | "GEO_HOLDOUT" | "CUSTOM";
                    testFilter: unknown;
                    /** @default null */
                    controlFilter?: unknown;
                    primaryMetric: string;
                    criterion: {
                        /** @enum {string} */
                        comparator: "lte" | "gte";
                        /** @enum {string} */
                        vs: "control" | "absolute";
                        value?: string;
                        minDays?: number;
                    };
                    startDate: string;
                    endDate: string;
                    /** Format: uuid */
                    ownerId?: string;
                };
            };
        };
        responses: {
            /** @description The experiment, PLANNED */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getExperiment: {
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
            /** @description { experiment, readout }: the planner's totals and weighted primary metric for test and control over the window, the delta and whether the criterion is met */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        test: {
                            budget: string | null;
                            actual: string | null;
                            metric: string | null;
                            leafCount: number;
                        };
                        control: {
                            budget: string | null;
                            actual: string | null;
                            metric: string | null;
                            leafCount: number;
                        } | null;
                        delta: {
                            abs: string;
                            pct: string | null;
                        } | null;
                        criterionMet: boolean | null;
                        daysRunning: number;
                    };
                };
            };
        };
    };
    updateExperiment: {
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
                    hypothesis?: string;
                    /** @enum {string} */
                    kind?: "PLATFORM_TEST" | "OBJECTIVE_TEST" | "AUDIENCE_TEST" | "CREATIVE_TEST" | "GEO_HOLDOUT" | "CUSTOM";
                    testFilter?: unknown;
                    controlFilter?: unknown;
                    primaryMetric?: string;
                    criterion?: {
                        /** @enum {string} */
                        comparator: "lte" | "gte";
                        /** @enum {string} */
                        vs: "control" | "absolute";
                        value?: string;
                        minDays?: number;
                    };
                    startDate?: string;
                    endDate?: string;
                    /** Format: uuid */
                    ownerId?: string;
                };
            };
        };
        responses: {
            /** @description Updated (not once concluded or abandoned) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    linkExperimentEnvelope: {
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
                    envelopeId: string;
                    /** @enum {string} */
                    role: "TEST" | "CONTROL";
                };
            };
        };
        responses: {
            /** @description Linked; a TEST envelope gets the system tag `experiment` */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    startExperiment: {
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
            /** @description PLANNED → RUNNING */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    evaluateExperiment: {
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
            /** @description RUNNING → EVALUATING */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    abandonExperiment: {
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
            /** @description → ABANDONED (not once concluded) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    concludeExperiment: {
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
                    decision: string;
                };
            };
        };
        responses: {
            /** @description CONCLUDED; the decision is posted as a comment in a thread on every linked envelope */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description No decision (min 20 characters), or no linked envelope */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getTimeline: {
        parameters: {
            query?: {
                /** @description FilterGroup as lz-string (or JSON) */
                filter?: string;
                /** @description Comma-separated dimension keys; default the hierarchy template's path */
                groupBy?: string;
                templateId?: string;
                from?: string;
                to?: string;
                /** @description Preset name or a PeriodSpec as JSON when from/to are not given; default current_year */
                period?: string;
                asOf?: string;
                zoom?: "week" | "month" | "quarter" | "fy";
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
            /** @description Group, envelope and target bars on the fiscal calendar, with markers and key dates; X-Data-Version header */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        bars: {
                            key: string;
                            parentKey: string | null;
                            level: number;
                            /** @enum {string} */
                            kind: "group" | "envelope" | "target" | "experiment";
                            name: string;
                            path: string[];
                            start: string;
                            end: string;
                            /** Format: uuid */
                            envelopeId?: string;
                            /** Format: uuid */
                            targetId?: string;
                            /** Format: uuid */
                            experimentId?: string;
                            metric?: string;
                            budget?: string;
                            actual?: string;
                            projected?: string;
                            spendPct?: number;
                            projectedPct?: number;
                            paceIndex?: number;
                            /**
                             * @default none
                             * @enum {string}
                             */
                            paceState: "under" | "on" | "over" | "critical" | "none";
                            status?: string;
                            /** @default false */
                            hasChildren: boolean;
                            /** @default false */
                            expanded: boolean;
                            /** @default 0 */
                            lane: number;
                            /** @default [] */
                            markers: {
                                /** @enum {string} */
                                kind: "approval" | "alert" | "closure" | "comment" | "version";
                                at: string;
                                id: string;
                                severity?: string;
                            }[];
                            value?: string;
                            comparator?: string;
                            /** Format: uuid */
                            inheritedFrom?: string;
                            effective?: {
                                start: string;
                                end: string;
                            }[];
                        }[];
                        /** @default [] */
                        levels: string[];
                        nextCursor: string | null;
                        calendar: {
                            fiscalYearStartMonth: number;
                            periods: {
                                id: string;
                                /** @enum {string} */
                                kind: "fy" | "quarter" | "month" | "week";
                                start: string;
                                end: string;
                                label: string;
                            }[];
                            keyDates: {
                                at: string;
                                label: string;
                                /** @enum {string} */
                                kind: "holiday" | "client" | "closure";
                            }[];
                        };
                        dataVersion: string;
                        /** Format: date-time */
                        dataAsOf: string;
                        /** Format: date-time */
                        asOf?: string;
                    };
                };
            };
        };
    };
    listSavedViews: {
        parameters: {
            query?: {
                screen?: string;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The caller's views and the workspace's shared ones */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createSavedView: {
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
                     * @default explorer
                     * @enum {string}
                     */
                    screen?: "explorer" | "alerts" | "approvals" | "targets" | "report" | "overview";
                    definition: {
                        [key: string]: unknown;
                    };
                    /**
                     * @default private
                     * @enum {string}
                     */
                    visibility?: "private" | "workspace";
                };
            };
        };
        responses: {
            /** @description Saved view; visibility workspace needs view.share_workspace */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deleteSavedView: {
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
            /** @description Removed; the audit row keeps what it was */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateSavedView: {
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
                    definition?: {
                        [key: string]: unknown;
                    };
                    /**
                     * @default private
                     * @enum {string}
                     */
                    visibility?: "private" | "workspace";
                };
            };
        };
        responses: {
            /** @description Updated view (owner, or an admin for a shared view) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    listPeriods: {
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
            /** @description The fiscal calendar: years, quarters, months as defined and custom partitions, each with its closure */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        key: string;
                        kind: string;
                        start: string;
                        end: string;
                        closure: {
                            /** Format: uuid */
                            id: string;
                            status: string;
                        } | null;
                    }[];
                };
            };
        };
    };
    createPeriod: {
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
                    /**
                     * @default custom
                     * @enum {string}
                     */
                    kind?: "year" | "quarter" | "month" | "custom";
                    start: string;
                    end: string;
                };
            };
        };
        responses: {
            /** @description Created; 409 when the key exists or it overlaps another period of its kind */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    generatePeriods: {
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
                    fiscalYear: number;
                    /**
                     * @default calendar
                     * @enum {string}
                     */
                    pattern?: "calendar" | "445" | "454" | "544";
                };
            };
        };
        responses: {
            /** @description { created, kept }: a fiscal year's periods in a pattern (calendar, 4-4-5, 4-5-4, 5-4-4); existing keys are kept */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getFiscalYearStart: {
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
            /** @description { startMonth }: the month the fiscal year starts in */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        startMonth: number;
                    };
                };
            };
        };
    };
    setFiscalYearStart: {
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
                    startMonth: number;
                };
            };
        };
        responses: {
            /** @description The month the fiscal year starts in; computed periods follow, rows stay */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    deletePeriod: {
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
            /** @description Deleted; 409 when it has a closure or budgets aligned to it */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updatePeriod: {
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
                    key?: string;
                    start?: string;
                    end?: string;
                };
            };
        };
        responses: {
            /** @description Updated; 409 when it has a closure (its dates are frozen in the report) */
            200: {
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
                                    key: "budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct";
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
                                    key: "status" | "owner_id" | "approver_id" | "requested_by" | "tag" | "currency" | "source_system" | "has_open_thread" | "mentions_user" | "commented_by" | "created_at" | "updated_at" | "start_date" | "end_date" | "name" | "has_attachments" | "alert_severity" | "is_leaf" | "parent_id" | "experiment";
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
                        measures?: ("budget" | "budget_in_period" | "actual" | "projected" | "remaining" | "variance_abs" | "variance_pct" | "pace_index" | "projected_close_pct" | "spend_to_date_pct" | "budget_baseline" | "budget_change_abs" | "budget_change_pct")[];
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
                        compareTo?: {
                            /** Format: uuid */
                            baselineId: string;
                        } | {
                            /** Format: date-time */
                            asOf: string;
                        };
                        /** Format: uuid */
                        templateId?: string;
                        subtree?: boolean;
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
    listNamingTemplates: {
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
            /** @description Naming templates, the active one of each kind first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    createNamingTemplate: {
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
                    kind: "display" | "match_key";
                    chips: ({
                        /** @enum {string} */
                        type: "dimension";
                        key: string;
                    } | {
                        /** @enum {string} */
                        type: "separator";
                        /** @enum {string} */
                        value: "_" | "-" | ":" | "·" | " " | "/" | "|";
                    } | {
                        /** @enum {string} */
                        type: "text";
                        value: string;
                    } | {
                        /** @enum {string} */
                        type: "period";
                        /** @enum {string} */
                        format: "yyyy" | "yyyy-QQ" | "yyyy-MM" | "MMM yyyy" | "fiscal";
                    })[];
                    /**
                     * @default original
                     * @enum {string}
                     */
                    casing?: "original" | "lower" | "upper";
                    /**
                     * @default keep
                     * @enum {string}
                     */
                    whitespace?: "keep" | "underscore" | "dash" | "remove";
                    /** @default false */
                    stripAccents?: boolean;
                };
            };
        };
        responses: {
            /** @description The new active template of its kind; envelopes renamed (or queued on a large workspace) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    previewNamingTemplate: {
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
                    template: {
                        /** @enum {string} */
                        kind: "display" | "match_key";
                        chips: ({
                            /** @enum {string} */
                            type: "dimension";
                            key: string;
                        } | {
                            /** @enum {string} */
                            type: "separator";
                            /** @enum {string} */
                            value: "_" | "-" | ":" | "·" | " " | "/" | "|";
                        } | {
                            /** @enum {string} */
                            type: "text";
                            value: string;
                        } | {
                            /** @enum {string} */
                            type: "period";
                            /** @enum {string} */
                            format: "yyyy" | "yyyy-QQ" | "yyyy-MM" | "MMM yyyy" | "fiscal";
                        })[];
                        /**
                         * @default original
                         * @enum {string}
                         */
                        casing?: "original" | "lower" | "upper";
                        /**
                         * @default keep
                         * @enum {string}
                         */
                        whitespace?: "keep" | "underscore" | "dash" | "remove";
                        /** @default false */
                        stripAccents?: boolean;
                    };
                    /** @default [] */
                    sampleEnvelopeIds?: string[];
                };
            };
        };
        responses: {
            /** @description { previews: [{ envelopeId, name, rendered }] } for the samples (five live leaves when none are given) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateNamingTemplate: {
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
                    chips?: ({
                        /** @enum {string} */
                        type: "dimension";
                        key: string;
                    } | {
                        /** @enum {string} */
                        type: "separator";
                        /** @enum {string} */
                        value: "_" | "-" | ":" | "·" | " " | "/" | "|";
                    } | {
                        /** @enum {string} */
                        type: "text";
                        value: string;
                    } | {
                        /** @enum {string} */
                        type: "period";
                        /** @enum {string} */
                        format: "yyyy" | "yyyy-QQ" | "yyyy-MM" | "MMM yyyy" | "fiscal";
                    })[];
                    /**
                     * @default original
                     * @enum {string}
                     */
                    casing?: "original" | "lower" | "upper";
                    /**
                     * @default keep
                     * @enum {string}
                     */
                    whitespace?: "keep" | "underscore" | "dash" | "remove";
                    stripAccents?: boolean;
                    isActive?: boolean;
                };
            };
        };
        responses: {
            /** @description A new version of the template */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getOverview: {
        parameters: {
            query?: {
                /** @description A relative preset (current_month, current_quarter, current_year, last_30_days, last_90_days, ytd, next_90_days) or fiscal:<key>, one of the workspace's periods (e.g. fiscal:2026-Q2) */
                period?: string;
                /** @description Heatmap rows: a registry granularity key (default country) */
                rows?: string;
                /** @description Heatmap columns: another granularity key (default platform) */
                cols?: string;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The Overview dashboard: heatmap (any two granularities; the registry's list for the pickers), top variances, KPI vs target, open alerts, approvals due, data freshness */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
                        /** Format: uuid */
                        assignTo?: string;
                    };
                    /** @default true */
                    isActive?: boolean;
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
    deleteRule: {
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
            /** @description The rule stops and is kept for its alerts' history; its open alerts are resolved */
            200: {
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
                        /** Format: uuid */
                        assignTo?: string;
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
    getWorkspaceGeneral: {
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
            /** @description The workspace's name, slug, reporting currency and fiscal-year start */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateWorkspaceGeneral: {
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
                };
            };
        };
        responses: {
            /** @description The renamed workspace */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getSlackSettings: {
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
            /** @description Whether the bot token and signing secret are set, the workspace's Slack settings, the URLs Slack calls and the app manifest */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    updateSlackSettings: {
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
                    defaultChannel?: string | null;
                    alertChannel?: string | null;
                    alertSeverities?: ("info" | "warning" | "critical" | "data")[];
                    approvals?: boolean;
                    link?: boolean;
                };
            };
        };
        responses: {
            /** @description The workspace's Slack settings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    sendSlackTest: {
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
                    channel?: string;
                };
            };
        };
        responses: {
            /** @description A test message is queued for the notify worker */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    slackInteractions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description What Slack expects: {} or form errors */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    slackCommands: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description An ephemeral reply */
            200: {
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
    appliedTags: {
        parameters: {
            query: {
                type: "envelope" | "target" | "alert" | "approval_request" | "thread";
                /** @description Comma-separated entity ids (up to 200) */
                ids: string;
            };
            header?: never;
            path: {
                ws: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Each entity id's tags; entities without tags are left out */
            200: {
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
            /** @description { groups: [{ type, count, more (count is a lower bound), hits: [{ id, title, path, status, facets, deepLink }] }], parsed } */
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
    getIconAsset: {
        parameters: {
            query?: never;
            header: {
                "X-Workspace-Id": string;
            };
            path: {
                file: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description An uploaded icon's sanitized SVG: { icon, svg } */
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
