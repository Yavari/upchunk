import xhr from 'xhr';
// NOTE: Need duplicate imports for Typescript version compatibility reasons (CJP)
/* tslint:disable-next-line no-duplicate-imports */
import type { XhrUrlConfig, XhrHeaders, XhrResponse } from 'xhr';
import { EventDispatcher } from './EventDispatcher'
import { Player } from './Player'
import { Chunk } from './Chunk';

type AllowedMethods = 'PUT' | 'POST' | 'PATCH';
const SUCCESSFUL_CHUNK_UPLOAD_CODES = [200, 201, 202, 204, 308];
const TEMPORARY_ERROR_CODES = [408, 502, 503, 504]; // These error codes imply a chunk may be retried
type UploadPredOptions = {
  retryCodes?: typeof TEMPORARY_ERROR_CODES;
  attempts: number;
  attemptCount: number;
};
const isSuccessfulChunkUpload = (
  res: XhrResponse | undefined,
  _options?: any
): res is XhrResponse =>
  !!res && SUCCESSFUL_CHUNK_UPLOAD_CODES.includes(res.statusCode);

const isRetriableChunkUpload = (
  res: XhrResponse | undefined,
  { retryCodes = TEMPORARY_ERROR_CODES }: UploadPredOptions
) => !res || retryCodes.includes(res.statusCode);

const isFailedChunkUpload = (
  res: XhrResponse | undefined,
  options: UploadPredOptions
): res is XhrResponse => {
  return (
    options.attemptCount >= options.attempts ||
    !(isSuccessfulChunkUpload(res) || isRetriableChunkUpload(res, options))
  );
};

export class ChunkUploader {
    private attemptCount: number;
    public currentXhr?: XMLHttpRequest;

    constructor(
        private eventDispatcher: EventDispatcher,
        private player: Player,
        private endpointValue: string,
        private method: AllowedMethods,
        private headers: XhrHeaders,
        private retryCodes: number[],
        public chunk: Chunk,
        private fileSize: number,
        private fileType: string,
        private chunkCount: number,
        private chunkSize: number,
        private attempts: number,
        private delayBeforeAttempt: number,
        private totalChunks: number,
        private chunkByteSize: number) 
    {
        this.attemptCount = 0;
    }

    public async sendChunkWithRetries(): Promise<boolean> {
        // What to do if a chunk was successfully uploaded
        const successfulChunkUploadCb = async (res: XhrResponse, _chunk?: Chunk) => {
          // Side effects
          // const lastChunkEnd = new Date();
          // const lastChunkInterval = (lastChunkEnd.getTime() - this.lastChunkStart.getTime()) / 1000;
    
          this.eventDispatcher.dispatch('chunkSuccess', {
            chunk: this.chunkCount,
            chunkSize: this.chunkSize,
            attempts: this.attemptCount,
            // timeInterval: lastChunkInterval,
            response: res,
          });
    
        //   if (this.dynamicChunkSize) {
        //     let unevenChunkSize = this.chunkSize;
        //     if (lastChunkInterval < 10) {
        //       unevenChunkSize = Math.min(this.chunkSize * 2, this.maxChunkSize);
        //     } else if (lastChunkInterval > 30) {
        //       unevenChunkSize = Math.max(this.chunkSize / 2, this.minChunkSize);
        //     }
        //     // ensure it's a multiple of 256k
        //     this.chunkSize = Math.ceil(unevenChunkSize / 256) * 256;
    
        //     // Re-estimate the total number of chunks, by adding the completed
        //     // chunks to the remaining chunks
        //     const remainingChunks =
        //       (this.file.size - this.nextChunkRangeStart) / this.chunkByteSize;
        //     this.totalChunks = Math.ceil(this.chunkCount + remainingChunks);
        //   }
    
          return true;
        };
    
        // What to do if a chunk upload failed, potentially after retries
        const failedChunkUploadCb = async (res: XhrResponse, _chunk?: Chunk) => {
          // Side effects
          this.eventDispatcher.dispatch('error', {
            message: `Server responded with ${
              (res as XhrResponse).statusCode
            }. Stopping upload.`,
            chunk: this.chunkCount,
            attempts: this.attemptCount,
          });
    
          return false;
        };
    
        // What to do if a chunk upload failed but is retriable and hasn't exceeded retry
        // count
        const retriableChunkUploadCb = async (
          _res: XhrResponse | undefined,
          _chunk?: Chunk
        ) => {
          // Side effects
          this.eventDispatcher.dispatch('attemptFailure', {
            message: `An error occured uploading chunk ${this.chunkCount}. ${
              this.attempts - this.attemptCount
            } retries left.`,
            chunkNumber: this.chunkCount,
            attemptsLeft: this.attempts - this.attemptCount,
          });
    
          return new Promise<boolean>((resolve) => {
            setTimeout(async () => {
              // Handle mid-flight _paused/offline cases here by storing the
              // "still retriable but yet to be uploaded chunk" in state.
              // See also: `sendChunks()`
              if (this.player.paused || this.player.offline) {
                resolve(false);
                return;
              }
              const chunkUploadSuccess = await this.sendChunkWithRetries();
              resolve(chunkUploadSuccess);
            }, this.delayBeforeAttempt * 1000);
          });
        };
    
        let res: XhrResponse | undefined;
        try {
          this.attemptCount = this.attemptCount + 1;
          // this.lastChunkStart = new Date();
          res = await this.sendChunk(this.chunk);
        } catch (_err) {
          // this type of error can happen after network disconnection on CORS setup
        }
        const options = {
          retryCodes: this.retryCodes,
          attemptCount: this.attemptCount,
          attempts: this.attempts,
        };
        if (isSuccessfulChunkUpload(res, options)) {
          return successfulChunkUploadCb(res, this.chunk);
        }
        if (isFailedChunkUpload(res, options)) {
          return failedChunkUploadCb(res, this.chunk);
        }
        // Retriable case
        return retriableChunkUploadCb(res, this.chunk);
      }
    
        /**
   * Send chunk of the file with appropriate headers
   */
  protected async sendChunk(chunk: Chunk) {
    const extraHeaders = this.headers;

    const headers = {
      ...extraHeaders,
      'Content-Type': this.fileType,
      'Content-Range': `bytes ${chunk.rangeStart}-${chunk.rangeEnd}/${this.fileSize}`,
    };

    this.eventDispatcher.dispatch('attempt', {
      chunkNumber: this.chunkCount,
      totalChunks: this.totalChunks,
      chunkSize: this.chunkSize,
    });

    return this.xhrPromise({
      headers,
      url: this.endpointValue,
      method: this.method,
      body: chunk.blob,
    });
  }

  private xhrPromise(options: XhrUrlConfig): Promise<XhrResponse> {
    const beforeSend = (xhrObject: XMLHttpRequest) => {
      xhrObject.upload.onprogress = (event: ProgressEvent) => {
        const remainingChunks = this.totalChunks - this.chunkCount;
        // const remainingBytes = this.file.size-(this.nextChunkRangeStart+event.loaded);
        const percentagePerChunk = (this.fileSize - this.chunk.rangeStart) / this.fileSize / remainingChunks;
        const successfulPercentage = this.chunk.rangeStart / this.fileSize;
        const currentChunkProgress = event.loaded / (event.total ?? this.chunkByteSize);
        const chunkPercentage = currentChunkProgress * percentagePerChunk;
        this.eventDispatcher.dispatch('progress', Math.min((successfulPercentage + chunkPercentage) * 100, 100));
      };
    };

    return new Promise((resolve, reject) => {
      this.currentXhr = xhr({ ...options, beforeSend }, (err, resp) => {
        this.currentXhr = undefined;
        if (err) {
          return reject(err);
        }

        return resolve(resp);
      });
    });
  }
}