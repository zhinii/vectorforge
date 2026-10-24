# Reference images, assisted reconstruction and AI previews

## English

### Start with an image
Choose **Photo**, then Choose Image or Take Photo. Images stay in this browser/project and are not sent to the drawing AI. Imported originals remain underlays rather than being artistically replaced. In Select mode, tap the image away from existing vector geometry to select it. The compact contextual panel offers Guided trace, Delete and Options. Options contains lock, opacity, width, calibration, advanced silhouette tracing and Rebuild sketch. Locked images can still be selected/deleted; unlock before moving or scaling. Drag a corner for uniform scale. Delete removes attached reference annotations but retains accepted vector paths; Undo restores the image and its annotations.

### Advanced silhouette trace
For the simpler pixel-guided boundary workflow, see the README. For global threshold silhouette tracing, open image Options → Advanced silhouette trace. Set a known length by picking two points and entering their real distance, then preview the outline. Calibration changes the reference image and attached annotations, not previously accepted vectors. Trace candidates follow the image's current transform. Threshold/speck/simplification settings are under Trace cleanup settings. Accept creates editable paths, including hole metadata. Uncalibrated tracing requires an explicit warning acknowledgement. Thick strokes may produce both edges, not a single centerline. Perspective is not corrected; check physical scale and drawing warnings before fabrication.

### Rebuild a dimensioned sketch
This is **assisted manual identification**, not OCR or general image recognition. Choose line, circle, arc, rectangle or orthogonal closed profile; pick landmarks on the drawing; then type real driving dimensions or explicitly associate an existing dimension note with each field. Image points establish approximate pose/topology, never manufacturing lengths. Confirm the shape and placement, preview, then accept. A rectangle with width 80 and height 40 becomes actual 80 × 40 mm geometry regardless of the photograph's apparent aspect ratio.

For an orthogonal profile, pick 4–32 corners in order and provide every edge's direction and length. Missing dimensions, inconsistent horizontal/vertical closure, intersections and invalid values block acceptance. Oblique landmarks are flagged for manual review; arbitrary freeform mechanical constraint solving is not supported. Use Trace profile for freeform silhouettes instead. Arc sweep is counterclockwise, greater than 0 and less than 360 degrees.

Accepted geometry retains a linked reconstruction recipe. Select it and choose Edit driving dimensions, or tap its blue dimension, to regenerate it from edited values. This operation is one Undo step. Direct grip/move/geometry changes detach the recipe rather than retaining misleading dimensions. Layer/hole/name metadata survives linked-dimension editing. Dimension-note association copies the confirmed current value; editing a reference note later does not silently change geometry. Project Save/Load preserves validated reconstruction recipes.

### AI and validation
Text prompts still use the existing connection. AI geometry now opens a separate proposed-versus-current preview. Accept changes the same editable document in one Undo step; Reject/Close/Escape changes nothing. Changes to the scene invalidate old candidates. AI edits to reconstructed geometry detach its driving recipe. Images, reference notes and reference-layer geometry are excluded from the AI scene by default.

This workflow provides drawing checks, not machine safety certification or a guarantee of fit/fabrication readiness. No image-recognition service, private image upload or paid provider call was used during development. Automated synthetic pointer tests cover touch/pinch interruption; physical-phone testing remains separate.

## 中文

### 图像与轮廓描摹
通过“图像／草图”选择图像或拍照。图像仅保存在浏览器／本地项目中，不会发送给绘图 AI。在“选择”模式下轻点图像，可直接删除、锁定、调整透明度、宽度或校准比例。已有矢量图形优先被选中。锁定图像仍可选择和删除，解锁后才能移动及拖动角点等比缩放。删除图像会删除其参考标注，但保留已接受的矢量路径；撤销可恢复。

描摹前选两个点并输入真实距离来校准。校准只更改参考图像和附属标注，不改变已有矢量路径。预览后接受会生成可编辑的轮廓路径。未经校准时必须明确确认警告。粗笔画可能产生双边轮廓，并非单线中心线；照片透视不会自动校正。加工前必须复核尺寸及图形检查。

### 根据尺寸重建
这是手动识别与尺寸驱动的辅助重建，并非自动识别手写尺寸或任意图像。选择直线、圆、圆弧、矩形或正交闭合轮廓，在图像中选特征点，然后输入真实驱动尺寸，或手动关联已有尺寸标注。图像点只用于提出位置、方向和拓扑，不会猜测加工长度。确认并预览后接受。例如宽80、高40会生成真实80×40毫米的矩形，不受照片视觉比例影响。

正交轮廓支持4–32个依次选取的角点，每条边都需提供方向及长度。缺少尺寸、水平／垂直闭合冲突、自交或无效数值会阻止接受。倾斜不明确的特征点会提示人工复核；不支持任意自由曲线机械约束求解，自由轮廓可使用描摹。圆弧按逆时针，扫角须大于0且小于360度。

接受后可选择图形并点击“编辑驱动尺寸”，或轻点蓝色尺寸，修改数值并重新生成。每次接受可一步撤销。直接拖动控制点、移动或改变几何形状会解除重建关联，避免旧尺寸误导。图层、孔洞及名称在关联尺寸编辑时保留。引用尺寸标注只复制当前确认值，之后改动标注不会偷偷改变几何图形。项目保存／加载保留经过验证的重建信息。

### AI预览与限制
文字提示仍使用原有连接。AI修改先显示当前／提议图形对照预览，接受后才修改同一可编辑文档，并可一步撤销；拒绝、关闭或Escape不修改文档。旧预览不能覆盖后来修改的图形。图像、参考标注及参考图层默认不会发送给AI。

检查结果是图形检查，不是机器安全认证，也不保证加工可用或服装合体。开发期间未使用图像识别服务、私人图像上传或付费模型请求。触摸及双指中断有合成事件测试覆盖，实体手机仍需单独验证。
