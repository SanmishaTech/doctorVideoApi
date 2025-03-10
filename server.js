// Project: NodeJS + MongoDB + ReactJS + Tailwind
// Features:
// 1. CRUD for doctors (Name, Designation, Degree, Mobile, Email)
// 2. SendGrid email with unique link for video recording
// 3. Real-time video saving on server
// 4. Finalize video recording upon finish button click
// S3 AccessKey: AKIAWIJIUX5FCZ3ZP2NQ
// S3 SecretAccessKey: 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

// Backend: Express + MongoDB + SendGrid
require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const sendgridMail = require('@sendgrid/mail');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

const app = express();
app.use(express.json());

// Configure CORS to allow requests from your frontend domain
const allowedOrigins = [process.env.FRONT_END_URL];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

sendgridMail.setApiKey(process.env.SENDGRID_API_KEY);

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Connect to MongoDB
mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.log("❌ MongoDB Connection Error:", err));

// Define Doctor Schema
const DoctorSchema = new mongoose.Schema({
    name: String,
    designation: String,
    degree: String,
    mobile: String,
    email: String,
    videoId: String,
});

// Create and use the Doctor model
const Doctor = mongoose.model("Doctor", DoctorSchema);

// Define Joi schema for validation
const doctorValidationSchema = Joi.object({
    name: Joi.string().required(),
    email: Joi.string().email().required(),
}).unknown(true); // Allow additional fields

// List all doctors
app.get("/doctors", async (req, res) => {
    try {
        const doctors = await Doctor.find();
        const updatedDoctors = await Promise.all(doctors.map(async doctor => {
            const videoUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/${doctor.videoId}/final_video.webm`;
            try {
                const result = await cloudinary.api.resource(`${doctor.videoId}/final_video`, { resource_type: 'video' });
                doctor = doctor.toObject();
                doctor.videoUrl = result.secure_url;
            } catch (error) {
                doctor = doctor.toObject();
                doctor.videoUrl = null;
            }
            return doctor;
        }));
        res.json(updatedDoctors);
    } catch (error) {
        console.error("❌ Error fetching doctors:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Create a new doctor
app.post('/doctors', async (req, res) => {
    const { error } = doctorValidationSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const doctor = new Doctor({ ...req.body, videoId: uuidv4() });
    await doctor.save();

    const emailContent = {
        to: doctor.email,
        from: 'webmaster@ehpl.net.in',
        subject: 'Record Your Introduction Video',
        text: `Click the link to record: ${process.env.FRONT_END_URL}/record/${doctor.videoId}`
    };

    sendgridMail.send(emailContent);
    res.status(201).json(doctor);
});

// Edit a doctor
app.put('/doctors/:id', async (req, res) => {
    const { error } = doctorValidationSchema.validate(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const doctor = await Doctor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(doctor);
});

// Delete a doctor
app.delete('/doctors/:id', async (req, res) => {
    try {
        const doctor = await Doctor.findByIdAndDelete(req.params.id);
        if (doctor) {
            if (doctor.videoUrl) {
                const publicId = doctor.videoUrl.split('/').pop().split('.')[0];
                cloudinary.uploader.destroy(publicId, { resource_type: 'video' }, (error, result) => {
                    if (error) {
                        console.error("❌ Error deleting video:", error);
                        return res.status(500).json({ message: "Server error", error: error.message });
                    }
                    res.json({ message: 'Doctor and related video files deleted successfully' });
                });
            } else {
                res.json({ message: 'Doctor and related video files deleted successfully' });
            }
        } else {
            res.status(404).json({ message: 'Doctor not found' });
        }
    } catch (error) {
        console.error("❌ Error deleting doctor:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Set up multer for handling multipart/form-data
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const videoDir = path.join(__dirname, 'videos', req.params.videoId);
        if (!fs.existsSync(videoDir)) {
            fs.mkdirSync(videoDir, { recursive: true });
        }
        cb(null, videoDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// Endpoint to receive video data
app.post('/upload/:videoId', upload.single('video'), (req, res) => {
    try {
        res.status(200).json({ message: 'Video chunk uploaded successfully' });
    } catch (error) {
        console.error("❌ Error uploading video chunk:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Endpoint to finalize video upload and join all chunks
app.post('/finishUpload/:videoId', async (req, res) => {
    const videoDir = path.join(__dirname, 'videos', req.params.videoId);
    const outputFilePath = path.join(videoDir, `${req.params.videoId}.webm`);

    try {
        const files = fs.readdirSync(videoDir).filter(file => file.endsWith('.webm'));
        files.sort(); // Ensure the chunks are in the correct order

        if (files.length === 0) {
            return res.status(400).json({ message: 'No video chunks found' });
        }

        const writeStream = fs.createWriteStream(outputFilePath);

        for (const file of files) {
            const filePath = path.join(videoDir, file);
            const data = fs.readFileSync(filePath);
            writeStream.write(data);
        }

        writeStream.end();

        writeStream.on('finish', async () => {
            try {
                const doctor = await Doctor.findOne({ videoId: req.params.videoId });
                const doctorName = doctor ? `Dr. ${doctor.name}` : 'Unknown Doctor';
        
                const result = await cloudinary.uploader.upload(outputFilePath, {
                    resource_type: 'video',
                    public_id: `${req.params.videoId}/final_video`,
                    transformation: [
                        {
                            overlay: {
                                font_family: "Arial",
                                font_size: 24,
                                font_weight: "bold",
                                text: encodeURIComponent(doctorName),
                                //url: "https://res.cloudinary.com/demo/image/upload/logos/cloudinary_icon_white.png"
                            },                            
                            //flags: "layer_apply",
                            gravity: "south",
                            y: 5,
                            color: "white",
                            background: "black",
                            crop: "fit"
                        }
                    ]                    
                });
        
                fs.unlinkSync(outputFilePath); // Remove the final video file
                doctor.videoUrl = result.secure_url;
                await doctor.save();
                res.status(200).json({ message: 'Video file created successfully', filePath: result.secure_url });
            } catch (error) {
                console.error("❌ Error uploading final video:", error);
                res.status(500).json({ message: "Server error", error: error.message });
            }
        });

        writeStream.on('error', (err) => {
            console.error("❌ Error joining video chunks:", err);
            res.status(500).json({ message: "Server error", error: err.message });
        });
    } catch (error) {
        console.error("❌ Error finalizing video upload:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Endpoint to delete all files from the specified video folder
app.delete('/deleteVideo/:videoId', async (req, res) => {
    const videoDir = path.join(__dirname, 'videos', req.params.videoId);

    try {
        if (fs.existsSync(videoDir)) {
            const files = fs.readdirSync(videoDir);
            for (const file of files) {
                fs.unlinkSync(path.join(videoDir, file));
            }
            fs.rmdirSync(videoDir);
        }
        res.status(200).json({ message: 'All video files deleted successfully' })

    } catch (error) {
        console.error("❌ Error deleting video files:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
});

// Serve static files from the videos directory
app.use('/videos', express.static(path.join(__dirname, 'videos')));

app.listen(5001, () => console.log('Server running on port 5001'));
