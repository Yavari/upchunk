export class Chunk {
    public rangeEnd: number;
    public constructor(
        public blob: Blob,
        public rangeStart: number,
    ) {
        this.rangeEnd = rangeStart + blob.size - 1;
     }
}