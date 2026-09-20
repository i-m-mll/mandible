/**
 * Reviewed parent-label assignments from mandible-metadata-exceptions@2.
 * These exact pairs are the only parent edges this migration creates when the
 * live label and project identities still match.
 */
export interface ReviewedParentEdgeMigrationRecord {
  readonly child_issue_id: string;
  readonly child_project: string;
  readonly label: string;
  readonly raw_ref: string;
  readonly parent_issue_id: string;
  readonly parent_project: string;
}

export const REVIEWED_PARENT_EDGE_MIGRATION_DATA: readonly ReviewedParentEdgeMigrationRecord[] = [
  {
    "child_issue_id": "58316eba673f76340a1c41b05d0bd9c4dc9608cffed189920d69c155be07c716",
    "child_project": "mandible",
    "label": "mandible:parent:44074ed",
    "raw_ref": "44074ed",
    "parent_issue_id": "44074ede2b58498c099aa8100a8d46d8cc7d5d6f6fbec9d47a19818e04caaa4d",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "f094416834f4aca31012d0b6021d71fb4d681edd9df5f8f09306a6fd59e18712",
    "child_project": "mandible",
    "label": "mandible:parent:44074ed",
    "raw_ref": "44074ed",
    "parent_issue_id": "44074ede2b58498c099aa8100a8d46d8cc7d5d6f6fbec9d47a19818e04caaa4d",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "05be8b926518954f456f7fcc9cd3d583df5d7f2bca9b3c5788d02a957e1b5ca0",
    "child_project": "dotfiles",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "0ca167a70d8b637d8fa1d37d7aadc6744134998efcbf9a2760895256a9745a6e",
    "child_project": "mandible",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "2f41b2affc8d7e2ddc67427693646a48b554e80667a040b9df1b73fc15dbd4da",
    "child_project": "mandible",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "3f2275e99ed193964742caaf9f271738d96abfc87bc3b3f056092d2292a2ccfc",
    "child_project": "mandible",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "731fdf703ba35a9fdcdc112b6405f56c08df07734ed46893fd4cac942f2d74f9",
    "child_project": "rlrmp",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "9382535898c87d255dbc261c52e8d679ed37f59f239cde28a931cc87dfed2e2d",
    "child_project": "dotfiles",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "acf7dbd7c89d8e3714c3b86abc85e42e7923c5e2d5739f1e8e71960ac2782436",
    "child_project": "mandible",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "d839c5034b9c41b7d9a940d590bed872049f654c5d0f7ee347d62755bac2ccfa",
    "child_project": "feedbax",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "dfc924a6d97fc42ee587078f98ab84dd023f1679719dbf8ffe63bd323a73297d",
    "child_project": "mandible",
    "label": "mandible:parent:59181bf",
    "raw_ref": "59181bf",
    "parent_issue_id": "59181bf38f439fa09d4a3a263f294e5927777dd570fd020a7b41a072f5e955b2",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "32ce2ea7073cb76f0a92872126a1c60cb392bfd014b298b836e0a0d034aef58f",
    "child_project": "rlrmp",
    "label": "mandible:parent:aacb9ed",
    "raw_ref": "aacb9ed",
    "parent_issue_id": "aacb9edbe23602bbcb766bdd20f97e01941efd3cb1577b174e50d0ecdc309f7c",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "57ab156d44d2f6974de7791a3b521b5c01c5b6bb37b674804d457431ac5cc686",
    "child_project": "rlrmp",
    "label": "mandible:parent:aacb9ed",
    "raw_ref": "aacb9ed",
    "parent_issue_id": "aacb9edbe23602bbcb766bdd20f97e01941efd3cb1577b174e50d0ecdc309f7c",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "99a2966183de2369c7fd246d061caec8d93ee5e9d092dcd2e34ca5eb22235a3c",
    "child_project": "rlrmp",
    "label": "mandible:parent:aacb9ed",
    "raw_ref": "aacb9ed",
    "parent_issue_id": "aacb9edbe23602bbcb766bdd20f97e01941efd3cb1577b174e50d0ecdc309f7c",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "a0a52ab58248a803f026caca9c3b953613d23367140833c0cdc8cd042049f62f",
    "child_project": "rlrmp",
    "label": "mandible:parent:aacb9ed",
    "raw_ref": "aacb9ed",
    "parent_issue_id": "aacb9edbe23602bbcb766bdd20f97e01941efd3cb1577b174e50d0ecdc309f7c",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "ba82f3d4e08dcb0e62ff73ffec2e1c547b73afc4b30c81187f7b4e677d36b6c9",
    "child_project": "rlrmp",
    "label": "mandible:parent:aacb9ed",
    "raw_ref": "aacb9ed",
    "parent_issue_id": "aacb9edbe23602bbcb766bdd20f97e01941efd3cb1577b174e50d0ecdc309f7c",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "ddf7f43b49f22847115fba82c7feecdb3f8e0e964c50980213dd3dcc68899429",
    "child_project": "rlrmp",
    "label": "mandible:parent:aacb9ed",
    "raw_ref": "aacb9ed",
    "parent_issue_id": "aacb9edbe23602bbcb766bdd20f97e01941efd3cb1577b174e50d0ecdc309f7c",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "1050b78fb365833ebad84956ee645945e8772ac50251fd58564943197c20d6d9",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "2dbf39f97062e094d6177f50fff0972e0e5a1343afd99e0c808e15820486d4a1",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "3992394b1fb07038a3b054f5ef23226332dbe7886ccd2b50d8afca12de43ae5c",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "3e66604c6a4aad499169bddf6d44259c339de7bc21aebb3e500e3694ce44098b",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "5f70333c066fbb2b2b25d58c381c9e9781d6ebd7b42e53ed4c66e66732d28862",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "69a9d74a86bf96c3eb979cd12e38074bbf0509f1607f57cdefb9b7d93ad4d932",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "72ab10c0a53344c0ba49921b3da48d366f0d58005c6b31c39c90d871efed3558",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "9035219ac3ea490d1de9d79ca3b03a066b05db4ebab9b2b85a15eee629694acb",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "aacb9edbe23602bbcb766bdd20f97e01941efd3cb1577b174e50d0ecdc309f7c",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "e04d819314d6877cbbb7a41843b88e9eacb9d14e650f60622dc129fc754ac0bc",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "eb1fa6c1d835fe3a96e5065914246014015236db89a071285033c660386219a7",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "ffff69965b1ef0e247f584bdf089a3901f69373d2016413caa43da156c5db418",
    "child_project": "rlrmp",
    "label": "mandible:parent:bd57e8f",
    "raw_ref": "bd57e8f",
    "parent_issue_id": "bd57e8fed0bc9d4fcf1ab05b019b0d941adf67e6f9f90f98f1df95477cb72fd2",
    "parent_project": "rlrmp"
  },
  {
    "child_issue_id": "2572858ec8339289c95dd69f872ff31814889361b99a181ee89348e0b40f91e3",
    "child_project": "mandible",
    "label": "parent:187573d",
    "raw_ref": "187573d",
    "parent_issue_id": "187573d591fb8282412b70ba5ac116d622dd21dac9b9ff1566fd3c7610ab2c72",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "3e21c7a42ec730e330183e489e7e08f847fac1983b41d6af414cff2d4b9fe8fb",
    "child_project": "mandible",
    "label": "parent:187573d",
    "raw_ref": "187573d",
    "parent_issue_id": "187573d591fb8282412b70ba5ac116d622dd21dac9b9ff1566fd3c7610ab2c72",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "f24644f722c8c042e372c2b0c06bef9282c3125f2075b647abe97a856e306e34",
    "child_project": "mandible",
    "label": "parent:187573d",
    "raw_ref": "187573d",
    "parent_issue_id": "187573d591fb8282412b70ba5ac116d622dd21dac9b9ff1566fd3c7610ab2c72",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "2706f09550f8c263a8d7c3be10bef67a002423462ea777627f5127faf40cbf37",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "4fe88a3c5df09a206ac93261ffae644ff16480b0413340b8ce08c6d884373fbf",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "638b779a97c2685b3632d9ba4ab05311b114df0cc688937d04b09ad72f0c8d74",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "6bc052ab53324e8c804e4195d74160d5c29a65a8acebd75edb24a55f3e783c82",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "9d657afae36408b0a000700c0fc792e5def5ba7b53fc6c857ac4ebd5cb37672d",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "b4fc8371de03c43aa9b3c4cd9bc26e242639317042f13220395f845afc3538fb",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "d45475e3180412f23ec958a80cd27ebe3e56aced9deb0dc89162d5951dc45dcc",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "e17cf2e5875ca6c4faab5227371f566271b59b782398e76b64ae09ddaf22b88d",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "fc54e0e5243c96aea5690510017a6bc3910952982c24e89a167ef4f576383c64",
    "child_project": "mandible",
    "label": "parent:1bae3c4",
    "raw_ref": "1bae3c4",
    "parent_issue_id": "1bae3c4ebeba02f00cf32c812f08f0975345e01ded83262122cda6f4f10f011b",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "23227265c07f54179350d15dbb3c30da8fa68d392aaf6aaeab86b2ab1edfbebb",
    "child_project": "mandible",
    "label": "parent:2472c51",
    "raw_ref": "2472c51",
    "parent_issue_id": "2472c511f4d658a3aacd72e4ddb91a420b92b25ff04c1c6bf8d48c1965684bd8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "339d1cccde121a198ed086946e83825e669f64b92cd5947c77928123d0193217",
    "child_project": "mandible",
    "label": "parent:2472c51",
    "raw_ref": "2472c51",
    "parent_issue_id": "2472c511f4d658a3aacd72e4ddb91a420b92b25ff04c1c6bf8d48c1965684bd8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "5423f64bb688ec363751d9642f8048ee0738f8808fa5ac0cbf65d46dcab3b585",
    "child_project": "mandible",
    "label": "parent:2472c51",
    "raw_ref": "2472c51",
    "parent_issue_id": "2472c511f4d658a3aacd72e4ddb91a420b92b25ff04c1c6bf8d48c1965684bd8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "a8fbc09a842806a5fc5265d70c206e25be6c0858c74f1f0fba1ae96afd77b354",
    "child_project": "mandible",
    "label": "parent:2472c51",
    "raw_ref": "2472c51",
    "parent_issue_id": "2472c511f4d658a3aacd72e4ddb91a420b92b25ff04c1c6bf8d48c1965684bd8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "acb4a06b78eb625221216d33efc2c82e578a9bf16f36d7371698f72c3e89bc03",
    "child_project": "mandible",
    "label": "parent:2472c51",
    "raw_ref": "2472c51",
    "parent_issue_id": "2472c511f4d658a3aacd72e4ddb91a420b92b25ff04c1c6bf8d48c1965684bd8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "child_project": "mandible",
    "label": "parent:2472c51",
    "raw_ref": "2472c51",
    "parent_issue_id": "2472c511f4d658a3aacd72e4ddb91a420b92b25ff04c1c6bf8d48c1965684bd8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "e967b9a51eecb10fe2e34f51e6d20c7e02e9504bda0b29d82f9ca7d17aacb75c",
    "child_project": "mandible",
    "label": "parent:2472c51",
    "raw_ref": "2472c51",
    "parent_issue_id": "2472c511f4d658a3aacd72e4ddb91a420b92b25ff04c1c6bf8d48c1965684bd8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "23227265c07f54179350d15dbb3c30da8fa68d392aaf6aaeab86b2ab1edfbebb",
    "child_project": "mandible",
    "label": "parent:32124c1",
    "raw_ref": "32124c1",
    "parent_issue_id": "32124c14de93ecc02c6ac387d3f219bb672bc31ba67327f61786c1d069e7f0d8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "d25bac5b7ca581e73e3fdd2c1284226cf5972fe972324badebde6bcff1f5c9aa",
    "child_project": "mandible",
    "label": "parent:32124c1",
    "raw_ref": "32124c1",
    "parent_issue_id": "32124c14de93ecc02c6ac387d3f219bb672bc31ba67327f61786c1d069e7f0d8",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "021c464f2a68c7c9064594888b5d63127adc3bff4bda5c81f14c4d6ee281c340",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "0cf5b136ec841f1aea743952b6b9f693a4d17db7f7fd4c26bc736d84f2ac0163",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "187573d591fb8282412b70ba5ac116d622dd21dac9b9ff1566fd3c7610ab2c72",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "1989184203f58c10a4ff0379ca9295c057581aad0133b77d2e67cb5ab70b7c0d",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "1a2fcce100d5edf3816e481ad323bf733d8bb69f2cf6dc22aafd9dda9418d972",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "1a457275f89ef26f67cf99ce092e07479a06f5508352cfc337d98b4f192daff9",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "2733a47f0ac32135fbc42d02c33c5164b4e32eb25f8a1607f98439ec0778119c",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "2dc97b8d3e22ff37500d289a51a6198b9c12165da32905e0514304513272146a",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "304aefa0e5fd44e5ff4929d650e6ea8cedc09208fed2cc4612aaa97ec0c16f36",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "4a0b3dfd977e5126d187888643d7aeb1e2fb89646a4f291383960fe0c2ef3421",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "4aa89bf0e812245d0d2d0ca049ba9c956200e728c4619f09994baaa85e333687",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "4c68a36d366b21a25da27ed1252ef4968b07e6207a90f508070cea166bcd6f0d",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "4fb8d9b6defba367d18f369c0b657654599eef74c5cd1621d2824577394680be",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "5f9a1f158c983031808c8cd29b8ca099e07a7d3cfdab3328c56cd5794460f322",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "7368894ff08824dd97cf3dae44a3489eae4eb38527e9486b8ec252f98b548f8f",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "96b5bff94b2fc1cbfa1a6e83ddcc6fa9294ca489555d4cde35b100e9421af2d9",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "9ede0fd50c3d1b6ecbe601e1c309de88f14e9467d2c4da20b1e9fef740c269a8",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "a4b049ce5b38823290f292cf48da86f571c2aa607e14cf7c13fbc2c0cb69a67b",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "a66a7e7c4b3d06b2738ef335f26e44127ffbee4e75e4910a5c66ef9da9e3d822",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "ada1e4302e1560a89d17f3fd4aa36f1728a1854ef3f4ddd20e53cccf7c551007",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "c64bee75e88cdcdbefe8a6d73754b3b6d98ca97553e0222c4d720ec008ce382c",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "dc87eb3a58c283a9cf91f7bcd9b37b34c8416a6383ad825d6327aa43fda46210",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "f25f330009a7baab9654f5a33c537815755046d03affed30237cd73cfaa4ec4b",
    "child_project": "mandible",
    "label": "parent:41d22a6",
    "raw_ref": "41d22a6",
    "parent_issue_id": "41d22a603c748ed8db7d0547b5e805dbd2540cf9506d34dcee889f2705abaebc",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "58316eba673f76340a1c41b05d0bd9c4dc9608cffed189920d69c155be07c716",
    "child_project": "mandible",
    "label": "parent:44074ed",
    "raw_ref": "44074ed",
    "parent_issue_id": "44074ede2b58498c099aa8100a8d46d8cc7d5d6f6fbec9d47a19818e04caaa4d",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "f094416834f4aca31012d0b6021d71fb4d681edd9df5f8f09306a6fd59e18712",
    "child_project": "mandible",
    "label": "parent:44074ed",
    "raw_ref": "44074ed",
    "parent_issue_id": "44074ede2b58498c099aa8100a8d46d8cc7d5d6f6fbec9d47a19818e04caaa4d",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "7495b92bcd2b4a49aecacab4dcd5ee754688d133809e1dd5535491196904f2ec",
    "child_project": "humbleb",
    "label": "parent:501b50e",
    "raw_ref": "501b50e",
    "parent_issue_id": "501b50ec6afe5d2b29222d333e10791c9c9ab62125448a1418024e74c9ab04fb",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "51832b91293875a5e6c2b26a6b8ef0b3d7aecfa30f7b2191ca13dfa36accf1d0",
    "child_project": "feedbax",
    "label": "parent:63c798f",
    "raw_ref": "63c798f",
    "parent_issue_id": "63c798f99e2d30278bd7a5cc2e0fa3587e89612df32eb64a3e95cef027b8e8ec",
    "parent_project": "feedbax"
  },
  {
    "child_issue_id": "90225ed22d521ef02a36cd11d3345beffa882731e9b4aada57c742e3ad697ba9",
    "child_project": "humbleb",
    "label": "parent:7495b92",
    "raw_ref": "7495b92",
    "parent_issue_id": "7495b92bcd2b4a49aecacab4dcd5ee754688d133809e1dd5535491196904f2ec",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "9bcdefcf9e9bb9d47a51e708c4dba02db562dbd1ae5fce67335eefc582435bbb",
    "child_project": "humbleb",
    "label": "parent:7495b92",
    "raw_ref": "7495b92",
    "parent_issue_id": "7495b92bcd2b4a49aecacab4dcd5ee754688d133809e1dd5535491196904f2ec",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "7495b92bcd2b4a49aecacab4dcd5ee754688d133809e1dd5535491196904f2ec",
    "child_project": "humbleb",
    "label": "parent:8229cc9",
    "raw_ref": "8229cc9",
    "parent_issue_id": "8229cc9da6f37e65e855d11090889048c68a3f92cbffff9456baa3519c10dc9a",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "90225ed22d521ef02a36cd11d3345beffa882731e9b4aada57c742e3ad697ba9",
    "child_project": "humbleb",
    "label": "parent:8229cc9",
    "raw_ref": "8229cc9",
    "parent_issue_id": "8229cc9da6f37e65e855d11090889048c68a3f92cbffff9456baa3519c10dc9a",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "9bcdefcf9e9bb9d47a51e708c4dba02db562dbd1ae5fce67335eefc582435bbb",
    "child_project": "humbleb",
    "label": "parent:8229cc9",
    "raw_ref": "8229cc9",
    "parent_issue_id": "8229cc9da6f37e65e855d11090889048c68a3f92cbffff9456baa3519c10dc9a",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "05966a50781870989f2bc0c9e501fed8bdecf1c42a6d4759e5c7d5661d5ff393",
    "child_project": "mandible",
    "label": "parent:8ec5295",
    "raw_ref": "8ec5295",
    "parent_issue_id": "8ec5295ce8426ddd6bb3d8e0f6b8c5fc0708a024e4559a9456a94c17f3a40b67",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "13f566283387fe486c599a6857739f624b64902674be9d281fd2ccabc9050aaa",
    "child_project": "mandible",
    "label": "parent:8ec5295",
    "raw_ref": "8ec5295",
    "parent_issue_id": "8ec5295ce8426ddd6bb3d8e0f6b8c5fc0708a024e4559a9456a94c17f3a40b67",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "c815e545f8e68c33b48ba66dff56ccf6370188d5adc1c35921d00f004b6e4331",
    "child_project": "mandible",
    "label": "parent:8ec5295",
    "raw_ref": "8ec5295",
    "parent_issue_id": "8ec5295ce8426ddd6bb3d8e0f6b8c5fc0708a024e4559a9456a94c17f3a40b67",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "90225ed22d521ef02a36cd11d3345beffa882731e9b4aada57c742e3ad697ba9",
    "child_project": "humbleb",
    "label": "parent:9bcdefc",
    "raw_ref": "9bcdefc",
    "parent_issue_id": "9bcdefcf9e9bb9d47a51e708c4dba02db562dbd1ae5fce67335eefc582435bbb",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "c9531c6c029ee8be01ca134c5d3d64111719dd4c699a6823986681ea00a5393e",
    "child_project": "mandible",
    "label": "parent:a8fbc09",
    "raw_ref": "a8fbc09",
    "parent_issue_id": "a8fbc09a842806a5fc5265d70c206e25be6c0858c74f1f0fba1ae96afd77b354",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "d25bac5b7ca581e73e3fdd2c1284226cf5972fe972324badebde6bcff1f5c9aa",
    "child_project": "mandible",
    "label": "parent:a8fbc09",
    "raw_ref": "a8fbc09",
    "parent_issue_id": "a8fbc09a842806a5fc5265d70c206e25be6c0858c74f1f0fba1ae96afd77b354",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "child_project": "mandible",
    "label": "parent:a8fbc09",
    "raw_ref": "a8fbc09",
    "parent_issue_id": "a8fbc09a842806a5fc5265d70c206e25be6c0858c74f1f0fba1ae96afd77b354",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "7495b92bcd2b4a49aecacab4dcd5ee754688d133809e1dd5535491196904f2ec",
    "child_project": "humbleb",
    "label": "parent:b013469",
    "raw_ref": "b013469",
    "parent_issue_id": "b013469463c98d6cbe8a7a76c0f8140cc08b0c0d3c0dca990e7396715c73f2d1",
    "parent_project": "humbleb"
  },
  {
    "child_issue_id": "51832b91293875a5e6c2b26a6b8ef0b3d7aecfa30f7b2191ca13dfa36accf1d0",
    "child_project": "feedbax",
    "label": "parent:c6c6da0",
    "raw_ref": "c6c6da0",
    "parent_issue_id": "c6c6da0df195d2d5d0befcef85982a77432b1d5d98e2aee889c96f1e123dc168",
    "parent_project": "feedbax"
  },
  {
    "child_issue_id": "c9531c6c029ee8be01ca134c5d3d64111719dd4c699a6823986681ea00a5393e",
    "child_project": "mandible",
    "label": "parent:d25bac5",
    "raw_ref": "d25bac5",
    "parent_issue_id": "d25bac5b7ca581e73e3fdd2c1284226cf5972fe972324badebde6bcff1f5c9aa",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "23227265c07f54179350d15dbb3c30da8fa68d392aaf6aaeab86b2ab1edfbebb",
    "child_project": "mandible",
    "label": "parent:de2f8ac",
    "raw_ref": "de2f8ac",
    "parent_issue_id": "de2f8acaf17c55becc86b9cb0eb5fad66eaa2d46c9380557171a2bde644c0a50",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "526a41fbe416757ce89339846eb75802bc79c709f6a725402dbafc43aa93b55c",
    "child_project": "mandible",
    "label": "parent:de2f8ac",
    "raw_ref": "de2f8ac",
    "parent_issue_id": "de2f8acaf17c55becc86b9cb0eb5fad66eaa2d46c9380557171a2bde644c0a50",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "a8fbc09a842806a5fc5265d70c206e25be6c0858c74f1f0fba1ae96afd77b354",
    "child_project": "mandible",
    "label": "parent:de2f8ac",
    "raw_ref": "de2f8ac",
    "parent_issue_id": "de2f8acaf17c55becc86b9cb0eb5fad66eaa2d46c9380557171a2bde644c0a50",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "child_project": "mandible",
    "label": "parent:de2f8ac",
    "raw_ref": "de2f8ac",
    "parent_issue_id": "de2f8acaf17c55becc86b9cb0eb5fad66eaa2d46c9380557171a2bde644c0a50",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "e967b9a51eecb10fe2e34f51e6d20c7e02e9504bda0b29d82f9ca7d17aacb75c",
    "child_project": "mandible",
    "label": "parent:de2f8ac",
    "raw_ref": "de2f8ac",
    "parent_issue_id": "de2f8acaf17c55becc86b9cb0eb5fad66eaa2d46c9380557171a2bde644c0a50",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "03dff5116f4b9be9da9e1cd06a1a9ee8ee0da4977dc217fd3c392ce723fd2f30",
    "child_project": "mandible",
    "label": "parent:de56ffa",
    "raw_ref": "de56ffa",
    "parent_issue_id": "de56ffabbbd05873773a438d3864eef57dee7621adf67e14f05ea31825e109d9",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "080db6f44f8a6875fefefb4e2b3963e749f587780c4c723e1fa1afedf8a610ac",
    "child_project": "mandible",
    "label": "parent:de56ffa",
    "raw_ref": "de56ffa",
    "parent_issue_id": "de56ffabbbd05873773a438d3864eef57dee7621adf67e14f05ea31825e109d9",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "339d1cccde121a198ed086946e83825e669f64b92cd5947c77928123d0193217",
    "child_project": "mandible",
    "label": "parent:e16807c",
    "raw_ref": "e16807c",
    "parent_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "526a41fbe416757ce89339846eb75802bc79c709f6a725402dbafc43aa93b55c",
    "child_project": "mandible",
    "label": "parent:e16807c",
    "raw_ref": "e16807c",
    "parent_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "5423f64bb688ec363751d9642f8048ee0738f8808fa5ac0cbf65d46dcab3b585",
    "child_project": "mandible",
    "label": "parent:e16807c",
    "raw_ref": "e16807c",
    "parent_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "c9531c6c029ee8be01ca134c5d3d64111719dd4c699a6823986681ea00a5393e",
    "child_project": "mandible",
    "label": "parent:e16807c",
    "raw_ref": "e16807c",
    "parent_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "d25bac5b7ca581e73e3fdd2c1284226cf5972fe972324badebde6bcff1f5c9aa",
    "child_project": "mandible",
    "label": "parent:e16807c",
    "raw_ref": "e16807c",
    "parent_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "e0b7f53e7ca87db7370a56bef1979c015cff4a27bdbab834e782ed66d93f68da",
    "child_project": "mandible",
    "label": "parent:e16807c",
    "raw_ref": "e16807c",
    "parent_issue_id": "e16807ceeb2f24d4f10db50f1efb02f2743173a6620196918b7359ef6fc32621",
    "parent_project": "mandible"
  },
  {
    "child_issue_id": "51832b91293875a5e6c2b26a6b8ef0b3d7aecfa30f7b2191ca13dfa36accf1d0",
    "child_project": "feedbax",
    "label": "parent:f68cf66",
    "raw_ref": "f68cf66",
    "parent_issue_id": "f68cf6676a7d3083addced6a3d9da0005310d565d5033ab34a753f6fb683875c",
    "parent_project": "feedbax"
  }
] as const;

