"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

interface UpdateDocumentRequest {
  filename: string;
}

interface UpdateDocumentResponse {
  task_id: string;
  filename: string;
  message: string;
}

async function updateDocumentByFilename(
  filename: string,
): Promise<UpdateDocumentResponse> {
  const response = await fetch("/api/langflow/update_ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filename } satisfies UpdateDocumentRequest),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to update document");
  }

  return response.json();
}

export const useUpdateDocument = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ filename }: UpdateDocumentRequest) =>
      updateDocumentByFilename(filename),
    onSettled: () => {
      // A re-ingest runs as a background task, so let the task list catch up
      // before refreshing the file views.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        queryClient.invalidateQueries({ queryKey: ["search"] });
        queryClient.invalidateQueries({ queryKey: ["listFiles"] });
        // Connector "Browse Files" dialogs cache per-file ingestion state.
        queryClient.invalidateQueries({ queryKey: ["browseConnectionFiles"] });
      }, 1000);
    },
  });
};
