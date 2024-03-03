// Imports
const {Storage} = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const sharp = require('sharp');

const getExif = require('exif-async');
const parseDMS = require('parse-dms');

const {Firestore} = require('@google-cloud/firestore');

// Entry point function
exports.generate_thumb_data = async (file, context) => {
  const gcsFile = file;
  const storage = new Storage();
  const sourceBucket = storage.bucket(gcsFile.bucket);
  const thumbnailsBucket = storage.bucket('sp24-41200-sparks-gj-thumbnails');
  const finalBucket = storage.bucket('sp24-41200-sparks-gj-final');

  //HINT HINT HINT
  const version = process.env.K_REVISION;
  console.log(`Running Cloud Function version ${version}`);

  console.log(`File name: ${gcsFile.name}`);
  console.log(`Generation number: ${gcsFile.generation}`);
  console.log(`Content type: ${gcsFile.contentType}`);

  // Reject images that are not jpeg or png files
  let fileExtension = '';
  let validFile = false;

  if (gcsFile.contentType === 'image/jpeg'){
      console.log('This is a jpg file.');
      fileExtension = 'jpg';
      validFile = true;
  } else if (gcsFile.contentType === 'image/png'){
      console.log('This is a png file.');
      fileExtension = 'png';
      validFile = true;
  } else{
      console.log('This is not a valid file.');
  }

  // If the file is a valid photograph, download it to the 'local' VM so that we can create a thumbnail image
  if (validFile) {
    // Create a new filename for the 'final' version of the image file
    // The value of this will be something like '12745649237578595.jpg'
    const finalFileName = `${gcsFile.generation}.${fileExtension}`;

    // Create a working directory on the VM that runs our GCF to download the original file
    // The value of this variable will be something like 'tmp/thumbs'
    const workingDir = path.join(os.tmpdir(), 'thumbs');

    // Create a variable that holds the path to the 'local' version of the file
    // The value of this will be something like 'tmp/thumbs/398575858493.png'
    const tempFilePath = path.join(workingDir, finalFileName);

    // Wait until the working directory is ready
    await fs.ensureDir(workingDir);

    // Download the original file to the path on the 'local' VM
    await sourceBucket.file(gcsFile.name).download({
      destination: tempFilePath
    });



    //Here is where I will extract exif data to enter into FireStore
    let gpsObject = await readExifData(tempFilePath);
    console.log(gpsObject);
    let gpsDecimal = getGPSCoordinates(gpsObject);
    console.log(gpsDecimal);
    console.log(gpsDecimal.lat);
    console.log(gpsDecimal.lon);




    // Upload our local version of the file to the final images bucket
    await finalBucket.upload(tempFilePath);
    
    // Create a name for the thumbnail image
    // The value for this will be something like `thumb@64_1234567891234567.jpg`
    const thumbName = `thumb@64_${finalFileName}`;

    // Create a path where we will store the thumbnail image locally
    // This will be something like `tmp/thumbs/thumb@64_1234567891234567.jpg`
    const thumbPath = path.join(workingDir, thumbName);

    // Use the sharp library to generate the thumbnail image and save it to the thumbPath
    // Then upload the thumbnail to the thumbnailsBucket in cloud storage
    await sharp(tempFilePath).resize(64).withMetadata().toFile(thumbPath).then(async () => {
      await thumbnailsBucket.upload(thumbPath);
    })

    // Delete the temp working directory and its files from the GCF's VM
    await fs.remove(workingDir);
    

      // Here is where I will connect to FireStore and create the objects
    const firestore = new Firestore({
      projectId: "sp24-41200-sparks-globaljags",
      // databaseId: "name if you changed it from default"
    });

    const photoData = {
      imageName: `${finalFileName}`,
      imageUrl: thumbnailsBucket.file(finalFileName).publicUrl(),
      lat:gpsDecimal.lat,
      lon:gpsDecimal.lon,
      thumbURL: finalBucket.file(thumbName).publicUrl()
    };

    let collectionRef = firestore.collection('photos');
    let documentRef = await collectionRef.add(photoData);
    console.log(`Document created: ${documentRef.id}`);
  
  } // end of validFile==true

  // DELETE the original file uploaded to the "Uploads" bucket
  await sourceBucket.file(gcsFile.name).delete();
  console.log(`Deleted uploaded file: ${gcsFile.name}`);
}



// Helper Functions
async function readExifData(localFile){
  let exifData;
  try{
      exifData = await getExif(localFile);
      //console.log(exifData);
      // console.log(exifData.gps);
      // console.log(exifData.gps.GPSLatitude);
      return exifData.gps;

  } catch(err){
      console.log(err);
      return null;
  }
}

function getGPSCoordinates(g){
  // PARSE DMS needs a string in format of:
  // 51:30:0.5486N 0:7:34.4503W
  // DEG:MIN:SECDIRECTION DEG:MIN:SECDIRECTION
  const latString = `${g.GPSLatitude[0]}:${g.GPSLatitude[1]}:${g.GPSLatitude[2]}${g.GPSLatitudeRef}`;
  const lonString = `${g.GPSLongitude[0]}:${g.GPSLongitude[1]}:${g.GPSLongitude[2]}${g.GPSLongitudeRef}`;

  const degCoords = parseDMS(`${latString} ${lonString}`);
  return degCoords;
}