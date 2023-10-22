// NOTE: Need duplicate imports for Typescript version compatibility reasons (CJP)
/* tslint:disable-next-line no-duplicate-imports */
import type { XhrHeaders } from 'xhr';

import { EventDispatcher, EventName } from './EventDispatcher'
import { Player } from './Player'
import { ChunkUploader } from './chunkUploader';
import { Chunk } from './Chunk';

const DEFAULT_CHUNK_SIZE = 30720;
const DEFAULT_MAX_CHUNK_SIZE = 512000; // in kB
const DEFAULT_MIN_CHUNK_SIZE = 256; // in kB

// Predicate function that returns true if a given `chunkSize` is valid, otherwise false.
// For `chunkSize` validity, we constrain by a min/max chunk size and conform to GCS:
// "The chunk size should be a multiple of 256 KiB (256 x 1024 bytes), unless it's the last
// chunk that completes the upload." (See: https://cloud.google.com/storage/docs/performing-resumable-uploads)
export const isValidChunkSize = (
  chunkSize: any,
  {
    minChunkSize = DEFAULT_MIN_CHUNK_SIZE,
    maxChunkSize = DEFAULT_MAX_CHUNK_SIZE,
  } = {}
): chunkSize is number | null | undefined => {
  return (
    chunkSize == null ||
    (typeof chunkSize === 'number' &&
      chunkSize >= 256 &&
      chunkSize % 256 === 0 &&
      chunkSize >= minChunkSize &&
      chunkSize <= maxChunkSize)
  );
};

// Projection function that returns an error associated with invalid `chunkSize` values.
export const getChunkSizeError = (
  chunkSize: any,
  {
    minChunkSize = DEFAULT_MIN_CHUNK_SIZE,
    maxChunkSize = DEFAULT_MAX_CHUNK_SIZE,
  } = {}
) => {
  return new TypeError(
    `chunkSize ${chunkSize} must be a positive number in multiples of 256, between ${minChunkSize} and ${maxChunkSize}`
  );
};

export type ChunkedStreamIterableOptions = {
  defaultChunkSize?: number;
  minChunkSize?: number;
  maxChunkSize?: number;
};

// An Iterable that accepts a readableStream of binary data (Blob | Uint8Array) and provides
// an asyncIterator which yields Blob values of the current chunkSize until done. Note that
// chunkSize may change between iterations.
export class ChunkedStreamIterable implements AsyncIterable<Blob> {
  protected _chunkSize: number | undefined;
  protected defaultChunkSize: number;
  public readonly minChunkSize: number;
  public readonly maxChunkSize: number;

  constructor(
    protected readableStream: ReadableStream<Uint8Array | Blob>,
    options: ChunkedStreamIterableOptions = {}
  ) {
    if (!isValidChunkSize(options.defaultChunkSize, options)) {
      throw getChunkSizeError(options.defaultChunkSize, options);
    }
    this.defaultChunkSize = options.defaultChunkSize ?? DEFAULT_CHUNK_SIZE;
    this.minChunkSize = options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
    this.maxChunkSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  }

  get chunkSize() {
    return this._chunkSize ?? this.defaultChunkSize;
  }

  set chunkSize(value) {
    if (!isValidChunkSize(value, this)) {
      throw getChunkSizeError(value, this);
    }
    this._chunkSize = value;
  }

  get chunkByteSize() {
    return this.chunkSize * 1024;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Blob> {
    let chunk;
    const reader = this.readableStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Last chunk, if any bits remain
          if (chunk) {
            const outgoingChunk = chunk;
            chunk = undefined;
            yield outgoingChunk;
          }
          break;
        }

        const normalizedBlobChunk =
          value instanceof Uint8Array
            ? new Blob([value], { type: 'application/octet-stream' })
            : value;

        chunk = chunk
          ? new Blob([chunk, normalizedBlobChunk])
          : normalizedBlobChunk;

        // NOTE: Since we don't know how big the next chunk needs to be, we should
        // just have a single blob that we "peel away bytes from" for each chunk
        // as we iterate.
        while (chunk) {
          if (chunk.size === this.chunkByteSize) {
            const outgoingChunk = chunk;
            chunk = undefined;
            yield outgoingChunk;
            break;
          } else if (chunk.size < this.chunkByteSize) {
            break;
          } else {
            const outgoingChunk = chunk.slice(0, this.chunkByteSize);
            chunk = chunk.slice(this.chunkByteSize);
            yield outgoingChunk;
          }
        }
      }
    } finally {
      // Last chunk, if any bits remain
      if (chunk) {
        const outgoingChunk = chunk;
        chunk = undefined;
        yield outgoingChunk;
      }
      reader.releaseLock();
      return;
    }
  }
}

const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried

type AllowedMethods = 'PUT' | 'POST' | 'PATCH';

export interface UpChunkOptions {
  endpoint: string | ((file?: File) => Promise<string>);
  file: File;
  method?: AllowedMethods;
  headers?: XhrHeaders | (() => XhrHeaders) | (() => Promise<XhrHeaders>);
  maxFileSize?: number;
  chunkSize?: number;
  attempts?: number;
  delayBeforeAttempt?: number;
  retryCodes?: number[];
  dynamicChunkSize?: boolean;
  maxChunkSize?: number;
  minChunkSize?: number;
  concurrentUploads?: number;
}

export class UpChunk {
  public static createUpload(options: UpChunkOptions) {
    return new UpChunk(options);
  }

  public endpoint: string | ((file?: File) => Promise<string>);
  public file: File;
  public headers: XhrHeaders | (() => XhrHeaders) | (() => Promise<XhrHeaders>);
  public method: AllowedMethods;
  public attempts: number;
  public delayBeforeAttempt: number;
  public retryCodes: number[];
  public dynamicChunkSize: boolean;
  protected chunkedStreamIterable: ChunkedStreamIterable;
  protected chunkedStreamIterator;

  protected ChunkUploaders: ChunkUploader[];
  private chunkCount: number;
  private maxFileBytes: number;
  private endpointValue: string;
  private totalChunks: number;
  private player: Player;

  private success: boolean;
  private nextChunkRangeStart: number;
  private eventDispatcher: EventDispatcher;
  private concurrentUploads: number;

  constructor(options: UpChunkOptions) {
    this.endpoint = options.endpoint;
    this.file = options.file;

    this.headers = options.headers || ({} as XhrHeaders);
    this.method = options.method || 'PUT';
    this.attempts = options.attempts || 5;
    this.delayBeforeAttempt = options.delayBeforeAttempt || 1;
    this.retryCodes = options.retryCodes || TEMPORARY_ERROR_CODES;
    this.dynamicChunkSize = options.dynamicChunkSize || false;

    this.maxFileBytes = (options.maxFileSize || 0) * 1024;
    this.chunkCount = 0;
    this.player = new Player();
    this.success = false;
    this.nextChunkRangeStart = 0;
    this.eventDispatcher = new EventDispatcher();
    this.ChunkUploaders = [];
    this.concurrentUploads = options.concurrentUploads || 1;

    // Types appear to be getting confused in env setup, using the overloaded NodeJS Blob definition, which uses NodeJS.ReadableStream instead
    // of the DOM type definitions. For definitions, See consumers.d.ts vs. lib.dom.d.ts. (CJP)
    this.chunkedStreamIterable = new ChunkedStreamIterable(
      this.file.stream() as unknown as ReadableStream<Uint8Array>,
      { ...options, defaultChunkSize: options.chunkSize }
    );
    this.chunkedStreamIterator =
      this.chunkedStreamIterable[Symbol.asyncIterator]();

    this.totalChunks = Math.ceil(this.file.size / this.chunkByteSize);

    this.validateOptions();
    this.getEndpoint().then(() => this.sendChunks());

    // restart sync when back online
    // trigger events when offline/back online
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (!this.player.offline) {
          return;
        }

        this.player.offline = false;
        this.eventDispatcher.dispatch('online');
        this.sendChunks();
      });

      window.addEventListener('offline', () => {
        this.player.offline = true;
        this.eventDispatcher.dispatch('offline');
      });
    }
  }

  protected get maxChunkSize() {
    return this.chunkedStreamIterable?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  }

  protected get minChunkSize() {
    return this.chunkedStreamIterable?.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
  }

  public get chunkSize() {
    return this.chunkedStreamIterable?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  public set chunkSize(value) {
    this.chunkedStreamIterable.chunkSize = value;
  }

  public get chunkByteSize() {
    return this.chunkedStreamIterable.chunkByteSize;
  }

  public get totalChunkSize() {
    return Math.ceil(this.file.size / this.chunkByteSize);
  }

  /**
   * Subscribe to an event
   */
  public on(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventDispatcher.eventTarget.addEventListener(eventName, fn as EventListener);
  }

  /**
   * Subscribe to an event once
   */
  public once(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventDispatcher.eventTarget.addEventListener(eventName, fn as EventListener, { once: true });
  }

  /**
   * Unsubscribe to an event
   */
  public off(eventName: EventName, fn: (event: CustomEvent) => void) {
    this.eventDispatcher.eventTarget.removeEventListener(eventName, fn as EventListener);
  }

  public get paused() {
    return this.player.paused;
  }

  public abort() {
    this.pause();
    this.ChunkUploaders.forEach((e) => e.currentXhr?.abort());
  }

  public pause() {
    this.player.paused = true;
  }

  public resume() {
    if (this.player.paused) {
      this.player.paused = false;

      this.sendChunks();
    }
  }

  /**
   * Validate options and throw errors if expectations are violated.
   */
  private validateOptions() {
    if (
      !this.endpoint ||
      (typeof this.endpoint !== 'function' && typeof this.endpoint !== 'string')
    ) {
      throw new TypeError(
        'endpoint must be defined as a string or a function that returns a promise'
      );
    }
    if (!(this.file instanceof File)) {
      throw new TypeError('file must be a File object');
    }
    if (this.headers && typeof this.headers !== 'function' && typeof this.headers !== 'object') {
      throw new TypeError('headers must be null, an object, or a function that returns an object or a promise');
    }
    if (
      !isValidChunkSize(this.chunkSize, {
        maxChunkSize: this.maxChunkSize,
        minChunkSize: this.minChunkSize,
      })
    ) {
      throw getChunkSizeError(this.chunkSize, {
        maxChunkSize: this.maxChunkSize,
        minChunkSize: this.minChunkSize,
      });
    }
    if (
      this.maxChunkSize &&
      (typeof this.maxChunkSize !== 'number' ||
        this.maxChunkSize < 256 ||
        this.maxChunkSize % 256 !== 0 ||
        this.maxChunkSize < this.chunkSize ||
        this.maxChunkSize < this.minChunkSize)
    ) {
      throw new TypeError(
        `maxChunkSize must be a positive number in multiples of 256, and larger than or equal to both ${this.minChunkSize} and ${this.chunkSize}`
      );
    }
    if (
      this.minChunkSize &&
      (typeof this.minChunkSize !== 'number' ||
        this.minChunkSize < 256 ||
        this.minChunkSize % 256 !== 0 ||
        this.minChunkSize > this.chunkSize ||
        this.minChunkSize > this.maxChunkSize)
    ) {
      throw new TypeError(
        `minChunkSize must be a positive number in multiples of 256, and smaller than ${this.chunkSize} and ${this.maxChunkSize}`
      );
    }
    if (this.maxFileBytes > 0 && this.maxFileBytes < this.file.size) {
      throw new Error(
        `file size exceeds maximum (${this.file.size} > ${this.maxFileBytes})`
      );
    }
    if (
      this.attempts &&
      (typeof this.attempts !== 'number' || this.attempts <= 0)
    ) {
      throw new TypeError('retries must be a positive number');
    }
    if (
      this.delayBeforeAttempt &&
      (typeof this.delayBeforeAttempt !== 'number' ||
        this.delayBeforeAttempt < 0)
    ) {
      throw new TypeError('delayBeforeAttempt must be a positive number');
    }
  }

  /**
   * Endpoint can either be a URL or a function that returns a promise that resolves to a string.
   */
  private getEndpoint() {
    if (typeof this.endpoint === 'string') {
      this.endpointValue = this.endpoint;
      return Promise.resolve(this.endpoint);
    }

    return this.endpoint(this.file).then((value) => {
      this.endpointValue = value;
      return this.endpointValue;
    });
  }
  /**
   * Manage the whole upload by calling getChunk & sendChunk
   * handle errors & retries and dispatch events
   */
  private async sendChunks() {
    // A "pending chunk" is a chunk that was unsuccessful but still retriable when
    // uploading was _paused or the env is offline. Since this may be the last
    if (this.ChunkUploaders.length > 0 && !(this.player.paused || this.player.offline)) {
      const oldChunkUploader = this.ChunkUploaders.pop() as ChunkUploader;
      const chunkUploader = new ChunkUploader(
        this.eventDispatcher,
        this.player,
        this.endpointValue,
        this.method,
        await (typeof this.headers === 'function' ? this.headers() : this.headers),
        this.retryCodes,
        oldChunkUploader.chunk,
        this.file.size,
        this.file.type,
        this.chunkCount,
        this.chunkSize,
        this.attempts,
        this.delayBeforeAttempt,
        this.totalChunks,
        this.chunkByteSize);

      const chunkUploadSuccess = await chunkUploader.sendChunkWithRetries();
      if (this.success && chunkUploadSuccess) {
        this.eventDispatcher.dispatch('success');
      }
    }

    while (!(this.success || this.player.paused || this.player.offline)) {
      let done = false;
      for (let i = 0; i < this.concurrentUploads; i +=1) {
        if (!done) {
          done = await this.pushUploader();
        }
      }

      const result = await Promise.all(this.ChunkUploaders.map(x => x.sendChunkWithRetries()));
      const chunkUploadSuccess = result.every(x => x);
      if (chunkUploadSuccess) {
        this.ChunkUploaders = [];
      }
      // NOTE: Need to disambiguate "last chunk to upload" (done) vs. "successfully"
      // uploaded last chunk to upload" (depends on status of sendChunkWithRetries),
      // specifically for "pending chunk" cases for the last chunk.
      this.success = done;
      if (this.success && chunkUploadSuccess) {
        this.eventDispatcher.dispatch('success');
      }
      if (!chunkUploadSuccess) {
        return;
      }
    }
  }

  private async pushUploader(): Promise<boolean> {
    const { value: chunk, done } = await this.chunkedStreamIterator.next();
    // NOTE: When `done`, `chunk` is undefined, so default `chunkUploadSuccess`
    // to be `true` on this condition, otherwise `false`.

    if (chunk) {
      const chunkUploader = new ChunkUploader(
        this.eventDispatcher,
        this.player,
        this.endpointValue,
        this.method,
        await (typeof this.headers === 'function' ? this.headers() : this.headers),
        this.retryCodes,
        new Chunk(chunk, this.nextChunkRangeStart),
        this.file.size,
        this.file.type,
        this.chunkCount,
        this.chunkSize,
        this.attempts,
        this.delayBeforeAttempt,
        this.totalChunks,
        this.chunkByteSize);

      this.ChunkUploaders.push(chunkUploader);
      this.nextChunkRangeStart += this.chunkSize;
      this.chunkCount += 1;
    }

    return !!done;
  }
}

export function createUpload(options: UpChunkOptions) {
  return UpChunk.createUpload(options);
}
