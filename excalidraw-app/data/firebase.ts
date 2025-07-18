import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";
import { Bytes } from "firebase/firestore";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  return {};
};

type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Bytes;
  ciphertext: Bytes;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext.toUint8Array();
  const iv = data.iv.toUint8Array();

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  // Use storage backend instead of Firebase Storage
  const BACKEND_V2_FILES_URL =
    import.meta.env.VITE_APP_BACKEND_V2_GET_URL?.replace(
      "/api/v2/",
      "/api/v2/files/",
    );

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  if (!BACKEND_V2_FILES_URL) {
    console.warn("No storage backend configured, skipping file save");
    // Mark all files as errored since we can't save them
    files.forEach(({ id }) => erroredFiles.push(id));
    return { savedFiles, erroredFiles };
  }

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(`${BACKEND_V2_FILES_URL}${id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
          },
          body: buffer,
        });

        if (response.ok) {
          savedFiles.push(id);
        } else {
          erroredFiles.push(id);
        }
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: Bytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: Bytes.fromUint8Array(iv),
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  try {
    // Use storage backend instead of Firebase
    const BACKEND_V2_ROOMS_URL =
      import.meta.env.VITE_APP_BACKEND_V2_GET_URL?.replace(
        "/api/v2/",
        "/api/v2/rooms/",
      );

    if (!BACKEND_V2_ROOMS_URL) {
      console.warn("No storage backend configured, skipping room save");
      return null;
    }

    // Create the scene document with encryption
    const storedScene = await createFirebaseSceneDocument(elements, roomKey);

    // Convert to binary data for storage backend
    const sceneData = JSON.stringify({
      sceneVersion: storedScene.sceneVersion,
      ciphertext: Array.from(storedScene.ciphertext.toUint8Array()),
      iv: Array.from(storedScene.iv.toUint8Array()),
    });

    // Save to storage backend using PUT method with binary data
    const response = await fetch(`${BACKEND_V2_ROOMS_URL}${roomId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: sceneData,
    });

    if (!response.ok) {
      throw new Error(`Failed to save room: ${response.status}`);
    }

    // Return the stored elements for consistency
    const storedElements = getSyncableElements(
      restoreElements(await decryptElements(storedScene, roomKey), null),
    );

    FirebaseSceneVersionCache.set(socket, storedElements);

    return storedElements;
  } catch (error) {
    console.error("Error saving to storage backend:", error);
    throw error;
  }
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  try {
    // Use storage backend instead of Firebase
    const BACKEND_V2_ROOMS_URL =
      import.meta.env.VITE_APP_BACKEND_V2_GET_URL?.replace(
        "/api/v2/",
        "/api/v2/rooms/",
      );

    if (!BACKEND_V2_ROOMS_URL) {
      console.warn("No storage backend configured, skipping room load");
      return null;
    }

    const response = await fetch(`${BACKEND_V2_ROOMS_URL}${roomId}`);

    if (response.status === 404) {
      return null; // Room doesn't exist
    }

    if (!response.ok) {
      throw new Error(`Failed to load room: ${response.status}`);
    }

    const sceneDataText = await response.text();
    const sceneData = JSON.parse(sceneDataText);

    // Reconstruct the Firebase-style scene object
    const storedScene = {
      sceneVersion: sceneData.sceneVersion,
      ciphertext: Bytes.fromUint8Array(new Uint8Array(sceneData.ciphertext)),
      iv: Bytes.fromUint8Array(new Uint8Array(sceneData.iv)),
    } as FirebaseStoredScene;

    const elements = getSyncableElements(
      restoreElements(await decryptElements(storedScene, roomKey), null),
    );

    if (socket) {
      FirebaseSceneVersionCache.set(socket, elements);
    }

    return elements;
  } catch (error) {
    console.error("Error loading from storage backend:", error);
    return null;
  }
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  // Use storage backend instead of Firebase Storage
  const BACKEND_V2_FILES_URL =
    import.meta.env.VITE_APP_BACKEND_V2_GET_URL?.replace(
      "/api/v2/",
      "/api/v2/files/",
    );

  if (!BACKEND_V2_FILES_URL) {
    console.warn("No storage backend configured, skipping file load");
    // Return empty results but don't error
    return { loadedFiles, erroredFiles };
  }

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(`${BACKEND_V2_FILES_URL}${id}`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
