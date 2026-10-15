Dyna Ops: Encord Automations

Internal Chrome MV3 extension for Encord label editor. Automates repetitive work our operators have to do curating data for robot model training.

Currently saves up to ~70 hours/week for our team of 21.

Design Choices:
Built as a standalone application with it's own menu component promoting separation of [some word I'm forgetting]. 

User layout & Encord DOM information are saved locally on Chrome cahce, keeping overall system architecture simple and secure. 

Encord mosaic layout tree is navigated to catpure current camera states including position, width, and height to restore later.

Least most annotated step on cam_high timeline is registered continuously, and used to center step +1 on steps panel component.

Grade-step annotates labels through explicit drag, click. select actions on the timeline and label panels. Injection is not possible since React tree updates are directly affected by server-side changes, which this plug-in does not have access to.

This product exemplifies taking what you can get and making the most out of it.
