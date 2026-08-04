import type {
  AdminOperationAction,
  AdminOperationCompletedEvent,
} from "./operations.ts";

/** AdminOperation-local fixture; shared event schemas remain owned by contracts/. */
export const adminOperationFixtures: {
  request: {
    operationId: string;
    action: AdminOperationAction;
    target: { resourceType: string; resourceId: string };
    requestedBy: string;
    reason: string;
    ticketId: string;
  };
  completed: AdminOperationCompletedEvent;
} = {
  request: {
    operationId: "operation_123",
    action: "server_suspend",
    target: { resourceType: "server", resourceId: "server_123" },
    requestedBy: "admin_123",
    reason: "Risk review",
    ticketId: "ticket_123",
  },
  completed: {
    eventType: "admin.operation.completed.v1",
    eventId: "m4-completed-operation_123",
    schemaVersion: 1,
    operationId: "operation_123",
    owner: "m4",
    status: "succeeded",
    completedAt: "2026-07-22T14:01:00.000Z",
  },
};
