const firebaseAdmin = require("firebase-admin");

// Initialize Firebase Admin if not already initialized
if (!firebaseAdmin.apps.length) {
    try {
        firebaseAdmin.initializeApp({
            credential: firebaseAdmin.credential.cert(require('../config/madanlalpansari-7881d-firebase-adminsdk-fbsvc-0d21b1d3f3.json'))
        });
        console.log('Firebase Admin initialized');
    } catch (error) {
        console.error('Error initializing Firebase Admin:', error);
    }
}

const sendNotification = async ({ deviceToken, title, body, type }) => {
    if (!deviceToken || deviceToken.trim() === "") {
        throw new Error("Device token is required");
    }

    const message = {
        token: deviceToken,
        notification: {
            title,
            body
        },
        ...(type != null ? { data: { type: String(type) } } : {}),
        android: {
            priority: "high",
            notification: {
                sound: "default",
                channelId: "default",
                clickAction: 'FLUTTER_NOTIFICATION_CLICK'
            }
        },
        apns: {
            payload: {
                aps: {
                    alert: {
                        title,
                        body
                    },
                    sound: "default",
                    badge: 1
                }
            }
        }
    };

    try {
        const response = await firebaseAdmin.messaging().send(message);
        // console.log('------------------sendnotification response',response)
        return {
            success: true,
            messageId: response,
            deviceToken
        };
    } catch (error) {
        // Handle specific FCM errors
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
            // Invalid or unregistered token - should be removed from database
            console.warn(`⚠️ Invalid token: ${deviceToken.substring(0, 20)}...`);
            throw new Error('INVALID_TOKEN');
        }

        console.error("❌ Error sending notification:", error.message);
        throw error;
    }
};

// Batch send notifications (for multiple tokens)
// const sendBatchNotifications = async (notifications) => {
//     const messages = notifications.map(({ deviceToken, title, body, data = {} }) => ({
//         token: deviceToken,
//         notification: {
//             title,
//             body
//         },
//         data: {
//             ...data,
//             click_action: 'FLUTTER_NOTIFICATION_CLICK'
//         },
//         android: {
//             priority: "high",
//             notification: {
//                 sound: "default",
//                 channelId: "default",
//                 clickAction: 'FLUTTER_NOTIFICATION_CLICK'
//             }
//         },
//         apns: {
//             payload: {
//                 aps: {
//                     alert: {
//                         title,
//                         body
//                     },
//                     sound: "default",
//                     badge: 1
//                 }
//             }
//         }
//     }));

//     try {
//         const response = await firebaseAdmin.messaging().sendEach(messages);
//         return {
//             successCount: response.successCount,
//             failureCount: response.failureCount,
//             responses: response.responses
//         };
//     } catch (error) {
//         console.error("❌ Error sending batch notifications:", error);
//         throw error;
//     }
// };

module.exports = sendNotification;
// module.exports.sendBatchNotifications = sendBatchNotifications;
