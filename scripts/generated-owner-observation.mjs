import { acceptedReleaseProducerReferences } from './accepted-release-retention.mjs';
console.log(JSON.stringify({ references: acceptedReleaseProducerReferences(JSON.parse(process.argv[2])) }));
